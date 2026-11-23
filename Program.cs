using System.Text.Json;
using System.Text.Json.Serialization;

internal sealed record Payment(string Id, int Price, int[] Tender);
internal sealed record Shift(int[] Denominations, int[] Opening, int[] Reserve, Payment[] Payments);
internal sealed record Receipt(string Id, string Status, long Paid, int[] Change, int ReserveUsed, int[] Drawer);

internal static class Program
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        RespectNullableAnnotations = true,
        RespectRequiredConstructorParameters = true,
        AllowDuplicateProperties = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        WriteIndented = true
    };

    private static void CheckCounts(int[] counts, int length)
    {
        if (counts.Length != length || counts.Any(n => n < 0))
            throw new ArgumentException("Cash counts must be nonnegative and match the denominations.");
    }

    private static object Replay(Shift shift)
    {
        int[] values = shift.Denominations;
        if (values.Length == 0 || values[0] <= 0 || !values.SequenceEqual(values.Distinct().Order()))
            throw new ArgumentException("Denominations must be positive, unique and ascending.");
        CheckCounts(shift.Opening, values.Length);
        CheckCounts(shift.Reserve, values.Length);
        int[] drawer = shift.Opening;
        var ids = new HashSet<string>();
        var receipts = new List<Receipt>();
        foreach (var payment in shift.Payments)
        {
            if (payment is null || string.IsNullOrWhiteSpace(payment.Id) || !ids.Add(payment.Id) || payment.Price < 0)
                throw new ArgumentException("Each payment needs a unique ID and a nonnegative integer price.");
            CheckCounts(payment.Tender, values.Length);
            long paid = payment.Tender.Select((count, i) => (long)count * values[i]).Sum();
            long due = paid - payment.Price;
            if (due > Change.MaximumTarget)
                throw new ArgumentException($"Payment {payment.Id} exceeds the supported change amount.");
            int[]? change = null;
            int reserveUsed = 0;
            if (due >= 0)
            {
                int[] available = drawer.Select((n, i) => n + payment.Tender[i]).ToArray();
                change = Change.Find(values, available, shift.Reserve, (int)due);
                if (change is not null)
                {
                    drawer = available.Select((n, i) => n - change[i]).ToArray();
                    reserveUsed = change.Select((n, i) =>
                        Math.Max(0, n - Math.Max(0, available[i] - shift.Reserve[i]))).Sum();
                }
            }
            string status = due < 0 ? "underpaid" : change is null ? "no_exact_change" : "accepted";
            receipts.Add(new(payment.Id, status, paid, change ?? new int[values.Length], reserveUsed, drawer));
        }
        return new { denominations = values, receipts, closing = drawer };
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1) throw new ArgumentException("Usage: TillChange <shift.json>");
            var shift = JsonSerializer.Deserialize<Shift>(File.ReadAllText(args[0]), Json)
                ?? throw new ArgumentException("Expected a shift object.");
            Console.WriteLine(JsonSerializer.Serialize(Replay(shift), Json));
            return 0;
        }
        catch (Exception error) when (error is ArgumentException or IOException or JsonException or OverflowException)
        {
            Console.Error.WriteLine(error.Message);
            return 2;
        }
    }
}
