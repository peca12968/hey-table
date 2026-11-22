import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.DateTimeException;
import java.time.Instant;
import java.util.zip.CRC32;
import java.util.zip.CheckedInputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Publish one immutable output segment and its matching continuation state. */
public final class ParcelBatch {
    private static final int MAGIC = 0x50574331; // PWC1, checkpoint format version 1.

    static void writeInstant(DataOutputStream out, Instant time) throws IOException {
        out.writeLong(time.getEpochSecond());
        out.writeInt(time.getNano());
    }

    static Instant readInstant(DataInputStream in) throws IOException {
        long seconds = in.readLong();
        int nanos = in.readInt();
        if (nanos < 0 || nanos >= 1_000_000_000) throw new IOException("invalid nanoseconds");
        return Instant.ofEpochSecond(seconds, nanos);
    }

    static void save(OutputStream stream, ParcelWindows.Counter counter, long batch, boolean terminal) throws IOException {
        var out = new DataOutputStream(stream);
        out.writeInt(MAGIC);
        out.writeLong(batch);
        out.writeBoolean(terminal);
        out.writeBoolean(counter.watermark != null);
        if (counter.watermark != null) writeInstant(out, counter.watermark);
        out.writeLong(counter.accepted);
        out.writeLong(counter.duplicates);
        out.writeLong(counter.late);
        out.writeLong(counter.conflicts);
        out.writeInt(counter.activeIds.size());
        for (var bucket : counter.windows.values()) {
            for (String id : bucket.ids) {
                var event = counter.activeIds.get(id);
                writeInstant(out, event.time());
                out.writeUTF(event.id());
                out.writeUTF(event.hub());
            }
        }
    }

    static void restore(DataInputStream in, ParcelWindows.Counter counter, long nextBatch) throws IOException {
        if (in.readInt() != MAGIC) throw new IOException("unknown checkpoint format");
        if (in.readLong() != nextBatch - 1) throw new IOException("batch must immediately follow its parent");
        if (in.readBoolean()) throw new IOException("parent is already final");
        counter.watermark = in.readBoolean() ? readInstant(in) : null;
        counter.accepted = in.readLong();
        counter.duplicates = in.readLong();
        counter.late = in.readLong();
        counter.conflicts = in.readLong();
        int active = in.readInt();
        if (active < 0 || counter.accepted < active || counter.duplicates < 0 || counter.late < 0 || counter.conflicts < 0)
            throw new IOException("invalid checkpoint counts");
        for (int i = 0; i < active; i++) {
            var scan = new ParcelWindows.Scan(readInstant(in), in.readUTF(), in.readUTF());
            Instant start = ParcelWindows.Counter.windowStart(scan.time());
            if (!ParcelWindows.IDENTIFIER.matcher(scan.id()).matches() || !ParcelWindows.IDENTIFIER.matcher(scan.hub()).matches()
                    || counter.watermark == null || counter.closed(start) || counter.activeIds.containsKey(scan.id()))
                throw new IOException("invalid active scan in checkpoint");
            counter.remember(start, scan);
        }
        if (in.read() != -1) throw new IOException("unexpected trailing checkpoint data");
    }

    static void load(Path parent, ParcelWindows.Counter counter, long nextBatch) throws IOException {
        try (var archive = new ZipFile(parent.toFile())) {
            for (String name : new String[]{"records.tsv", "state.bin"}) {
                var entry = archive.getEntry(name);
                if (entry == null) throw new IOException("missing archive entry " + name);
                var crc = new CRC32();
                try (var stream = new CheckedInputStream(new BufferedInputStream(archive.getInputStream(entry)), crc)) {
                    if (name.equals("state.bin")) restore(new DataInputStream(stream), counter, nextBatch);
                    else stream.transferTo(OutputStream.nullOutputStream());
                }
                if (crc.getValue() != entry.getCrc()) throw new IOException("checksum mismatch in " + name);
            }
        }
    }

    static void publish(long batch, Path parent, Path target, BufferedReader input, boolean terminal) throws IOException {
        if (batch <= 0 || (parent == null) != (batch == 1))
            throw new IOException("batch 1 starts without a parent; later batches require a parent");
        if (Files.exists(target)) throw new IOException("batch output already exists: " + target);
        Path staging = Files.createTempFile(target.toAbsolutePath().getParent(), ".parcel-", ".tmp");
        try {
            try (var zip = new ZipOutputStream(new BufferedOutputStream(Files.newOutputStream(staging)))) {
                zip.putNextEntry(new ZipEntry("records.tsv"));
                var out = new PrintStream(zip, false, StandardCharsets.UTF_8);
                var counter = new ParcelWindows.Counter(out);
                if (parent != null) load(parent, counter, batch);
                ParcelWindows.consume(input, counter);
                if (terminal) counter.finish();
                if (out.checkError()) throw new IOException("could not write batch records");
                zip.closeEntry();
                zip.putNextEntry(new ZipEntry("state.bin"));
                save(zip, counter, batch, terminal);
                zip.closeEntry();
            }
            // Link only after both ZIP entries and the central directory are closed.
            // Creating the name also refuses a concurrent publisher's existing result.
            Files.createLink(target, staging);
        } finally {
            Files.deleteIfExists(staging);
        }
    }

    public static void main(String[] args) {
        if (args.length != 5 || !(args[0].equals("append") || args[0].equals("finish"))) {
            System.err.println("Usage: ParcelBatch append|finish BATCH_NUMBER PARENT.zip|- OUTPUT.zip INPUT.tsv|-");
            System.exit(2);
        }
        try (BufferedReader input = args[4].equals("-")
                ? new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8.newDecoder()))
                : Files.newBufferedReader(Path.of(args[4]), StandardCharsets.UTF_8)) {
            Path parent = args[2].equals("-") ? null : Path.of(args[2]);
            publish(Long.parseLong(args[1]), parent, Path.of(args[3]), input, args[0].equals("finish"));
        } catch (IOException | IllegalArgumentException | DateTimeException | UnsupportedOperationException error) {
            System.err.println("Batch failed: " + error);
            System.exit(1);
        }
    }
}
