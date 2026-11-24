using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

return Run(args);

static int Run(string[] args)
{
    try
    {
        switch (args)
        {
            case ["generate-key", var privatePath]:
                using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
                    Publish(privatePath, Encoding.ASCII.GetBytes(key.ExportPkcs8PrivateKeyPem()), privateFile: true);
                return 0;
            case ["public-key", var privatePath]:
                using (var key = ReadKey(privatePath, signing: true))
                    Console.WriteLine(key.ExportSubjectPublicKeyInfoPem());
                return 0;
            case ["pack", var privatePath, var shift, var destination, .. var files]:
                if (files.Length is < 1 or > Docket.MaximumBatches)
                    throw new ArgumentException($"Provide 1 to {Docket.MaximumBatches} Stockroom receipts.");
                var batchReceipts = files.Select(file => Docket.Decode<Batch>(ReadFile(file, 65536))).ToArray();
                using (var key = ReadKey(privatePath, signing: true))
                    Publish(destination, Docket.Pack(shift, batchReceipts, key));
                return 0;
            case ["verify", var publicPath, var shift, var package]:
                using (var key = ReadKey(publicPath, signing: false))
                    Console.WriteLine(Docket.Verify(shift, ReadFile(package, Docket.MaximumPackageBytes), key));
                return 0;
            default:
                Console.Error.WriteLine("""
                    return-docket generate-key PRIVATE.pem
                    return-docket public-key PRIVATE.pem
                    return-docket pack PRIVATE.pem SHIFT OUTPUT.json RECEIPT.json [RECEIPT.json ...]
                    return-docket verify PUBLIC.pem SHIFT PACKAGE.json
                    """);
                return 2;
        }
    }
    catch (DocketVerificationException error)
    {
        Console.Error.WriteLine(error.Message);
        return 1;
    }
    catch (Exception error) when (error is IOException or JsonException or ArgumentException
                                  or CryptographicException or UnauthorizedAccessException)
    {
        Console.Error.WriteLine(error.Message);
        return 2;
    }
}

static ECDsa ReadKey(string path, bool signing)
{
    var pem = Encoding.UTF8.GetString(ReadFile(path, 4096)).Trim().TrimStart('\uFEFF').Trim();
    var label = signing ? "PRIVATE KEY" : "PUBLIC KEY";
    if (!PemEncoding.TryFind(pem, out var fields) || pem[fields.Label] != label ||
        fields.Location.GetOffsetAndLength(pem.Length) != (0, pem.Length))
        throw new ArgumentException($"Expected one {label} PEM block.");

    var key = ECDsa.Create();
    try
    {
        key.ImportFromPem(pem);
        if (key.ExportParameters(false).Curve.Oid.Value != "1.2.840.10045.3.1.7")
            throw new ArgumentException("Expected a P-256 key.");
        return key;
    }
    catch
    {
        key.Dispose();
        throw;
    }
}

static byte[] ReadFile(string path, int limit)
{
    using var file = File.OpenRead(path);
    if (file.Length > limit)
        throw new ArgumentException($"Input exceeds {limit} bytes.");
    var bytes = new byte[file.Length];
    file.ReadExactly(bytes);
    if (file.ReadByte() != -1)
        throw new IOException("Input grew while reading.");
    return bytes;
}

static void Publish(string path, byte[] contents, bool privateFile = false)
{
    var target = Path.GetFullPath(path);
    var staged = Path.Combine(Path.GetDirectoryName(target)!, $".return-docket-{Guid.NewGuid():N}.tmp");
    var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
    if (privateFile && !OperatingSystem.IsWindows())
        options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    var file = new FileStream(staged, options);
    try
    {
        using (file)
        {
            file.Write(contents);
            file.Flush(flushToDisk: true);
        }
        if (OperatingSystem.IsWindows())
        {
            File.Move(staged, target, overwrite: false);
        }
        else
        {
            // A same-directory link publishes the complete file and tests name availability in one operation.
            if (Link(staged, target) != 0)
            {
                var cause = new Win32Exception(Marshal.GetLastPInvokeError());
                throw new IOException($"Unable to publish '{target}': {cause.Message}", cause);
            }
        }
    }
    finally
    {
        File.Delete(staged);
    }
}

[DllImport("libc", EntryPoint = "link", SetLastError = true)]
static extern int Link([MarshalAs(UnmanagedType.LPUTF8Str)] string existingPath,
                       [MarshalAs(UnmanagedType.LPUTF8Str)] string newPath);

internal sealed record Box(string ReservationId, string ShipmentId, string ReturnId, int Quantity, int ReturnableAfter);
internal sealed record Batch(string BatchId, Box[] Boxes);
internal sealed record Payload(string Format, string Shift, Batch[] Batches);
internal sealed record Package(string Format, byte[] Payload, byte[] Signature);
internal sealed class DocketVerificationException(string message) : Exception(message);

internal static class Docket
{
    internal const int MaximumBatches = 50;
    internal const int MaximumPackageBytes = 2 * 1024 * 1024;
    private const string Format = "return-docket.v1";
    private const DSASignatureFormat SignatureFormat = DSASignatureFormat.Rfc3279DerSequence;
    private static readonly Regex Id = new(@"\A[a-zA-Z0-9_-]{1,80}\z", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerOptions.Strict)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        MaxDepth = 12,
    };

    internal static T Decode<T>(ReadOnlySpan<byte> input) where T : class
    {
        if (input.StartsWith(new byte[] { 0xef, 0xbb, 0xbf }))
            input = input[3..];
        return JsonSerializer.Deserialize<T>(input, Json) ?? throw new JsonException("Expected a JSON object.");
    }

    internal static byte[] Pack(string shift, Batch[] batches, ECDsa key)
    {
        var value = new Payload(Format, shift, batches);
        Inspect(value);
        var ordered = batches.OrderBy(batch => batch.BatchId, StringComparer.Ordinal)
            .Select(batch => batch with
            {
                Boxes = batch.Boxes.OrderBy(box => box.ReservationId, StringComparer.Ordinal)
                    .ThenBy(box => box.ShipmentId, StringComparer.Ordinal).ToArray()
            }).ToArray();
        var payload = JsonSerializer.SerializeToUtf8Bytes(value with { Batches = ordered }, Json);
        var signature = key.SignData(payload, HashAlgorithmName.SHA256, SignatureFormat);
        var package = JsonSerializer.SerializeToUtf8Bytes(new Package(Format, payload, signature), Json);
        if (package.Length > MaximumPackageBytes)
            throw new ArgumentException("The signed package exceeds the size limit.");
        return package;
    }

    internal static string Verify(string shift, byte[] input, ECDsa key)
    {
        var package = Decode<Package>(input);
        if (package.Format != Format || package.Signature.Length is < 8 or > 72 ||
            !key.VerifyData(package.Payload, package.Signature, HashAlgorithmName.SHA256, SignatureFormat))
            throw new DocketVerificationException("Package signature or format does not match.");
        var value = Decode<Payload>(package.Payload);
        var (boxes, units) = Inspect(value);
        if (value.Shift != shift)
            throw new DocketVerificationException("The verified shift differs from the expected shift.");
        return JsonSerializer.Serialize(new { value.Shift, BatchCount = value.Batches.Length,
            BoxCount = boxes, Units = units, value.Batches }, Json);
    }

    private static (int Boxes, long Units) Inspect(Payload payload)
    {
        if (payload.Format != Format || !Id.IsMatch(payload.Shift) ||
            payload.Batches.Length is < 1 or > MaximumBatches)
            throw new ArgumentException("Invalid package format, shift or length.");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var boxCount = 0;
        long returnedUnits = 0;
        foreach (var batch in payload.Batches)
        {
            if (batch is null || !Id.IsMatch(batch.BatchId) || !seen.Add(batch.BatchId) ||
                batch.Boxes.Length is < 1 or > 100)
                throw new ArgumentException("Invalid or repeated return batch.");
            var boxIds = new HashSet<(string, string)>();
            foreach (var box in batch.Boxes)
            {
                if (box is null || !Id.IsMatch(box.ReservationId) || !Id.IsMatch(box.ShipmentId) ||
                    box.ReturnId != batch.BatchId || box.Quantity is < 1 or > 1_000_000 ||
                    box.ReturnableAfter < 0 || !boxIds.Add((box.ReservationId, box.ShipmentId)))
                    throw new ArgumentException("Invalid or repeated return receipt.");
                boxCount++;
                returnedUnits += box.Quantity;
            }
        }
        return (boxCount, returnedUnits);
    }
}
