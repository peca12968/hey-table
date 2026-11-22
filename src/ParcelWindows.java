import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Pattern;

public final class ParcelWindows {
    private static final long WINDOW_SECONDS = 300;
    private static final long LATENESS_SECONDS = 120;
    static final Pattern IDENTIFIER = Pattern.compile("[A-Za-z0-9_.-]{1,80}");

    record Scan(Instant time, String id, String hub) {}

    static final class Bucket {
        final Map<String, Long> counts = new TreeMap<>();
        final List<String> ids = new ArrayList<>();
    }

    static final class Counter {
        final TreeMap<Instant, Bucket> windows = new TreeMap<>();
        final Map<String, Scan> activeIds = new HashMap<>();
        final PrintStream out;
        Instant watermark;
        long accepted, duplicates, late, conflicts;

        Counter(PrintStream out) {
            this.out = out;
        }

        static Instant windowStart(Instant time) {
            return Instant.ofEpochSecond(Math.floorDiv(time.getEpochSecond(), WINDOW_SECONDS) * WINDOW_SECONDS);
        }

        boolean closed(Instant start) {
            return watermark != null && !start.plusSeconds(WINDOW_SECONDS).isAfter(watermark);
        }

        void scan(Scan event) {
            Instant start = windowStart(event.time());
            if (closed(start)) {
                late++;
                reject("late", event);
                return;
            }

            Scan previous = activeIds.get(event.id());
            if (previous != null) {
                if (previous.equals(event)) {
                    duplicates++;
                } else {
                    conflicts++;
                    reject("conflict", event);
                }
                return;
            }

            remember(start, event);
            accepted++;
            advance(event.time().minusSeconds(LATENESS_SECONDS));
        }

        void remember(Instant start, Scan event) {
            Bucket bucket = windows.computeIfAbsent(start, ignored -> new Bucket());
            bucket.counts.merge(event.hub(), 1L, Long::sum);
            bucket.ids.add(event.id());
            activeIds.put(event.id(), event);
        }

        void reject(String reason, Scan event) {
            out.println(String.join("\t", "REJECT", reason, event.time().toString(),
                                    event.id(), event.hub(), watermark.toString()));
        }

        void advance(Instant next) {
            if (watermark != null && !next.isAfter(watermark)) {
                return;
            }
            watermark = next;
            while (!windows.isEmpty() && !windows.firstKey().plusSeconds(WINDOW_SECONDS).isAfter(next)) {
                emitOldest();
            }
        }

        void emitOldest() {
            var entry = windows.pollFirstEntry();
            Instant start = entry.getKey();
            Bucket bucket = entry.getValue();
            bucket.counts.forEach((hub, count) ->
                    out.println(String.join("\t", "WINDOW", start.toString(),
                            start.plusSeconds(WINDOW_SECONDS).toString(), hub, count.toString())));
            bucket.ids.forEach(activeIds::remove);
        }

        void finish() {
            while (!windows.isEmpty()) {
                emitOldest();
            }
            out.printf(Locale.ROOT, "SUMMARY\taccepted=%d\tduplicates=%d\tlate=%d\tconflicts=%d%n",
                       accepted, duplicates, late, conflicts);
        }
    }

    static Instant timestamp(String value) {
        return OffsetDateTime.parse(value).toInstant();
    }

    static void consume(BufferedReader reader, Counter counter) throws IOException {
        long number = 0;
        String line;
        while ((line = reader.readLine()) != null) {
            number++;
            String[] fields = line.split("\t", -1);
            try {
                if (fields.length == 4 && fields[0].equals("SCAN")) {
                    if (!IDENTIFIER.matcher(fields[2]).matches() || !IDENTIFIER.matcher(fields[3]).matches()) {
                        throw new IllegalArgumentException("invalid scan ID or hub");
                    }
                    counter.scan(new Scan(timestamp(fields[1]), fields[2], fields[3]));
                } else if (fields.length == 2 && fields[0].equals("WATERMARK")) {
                    counter.advance(timestamp(fields[1]));
                } else {
                    throw new IllegalArgumentException("expected SCAN or WATERMARK with tab-separated fields");
                }
            } catch (DateTimeException | IllegalArgumentException error) {
                throw new IllegalArgumentException("line " + number + ": " + error.getMessage(), error);
            }
            if (counter.out.checkError()) {
                throw new IOException("output stream failed");
            }
        }
    }

    static void process(BufferedReader reader, PrintStream out) throws IOException {
        Counter counter = new Counter(out);
        consume(reader, counter);
        counter.finish();
        if (out.checkError()) {
            throw new IOException("output stream failed");
        }
    }

    public static void main(String[] args) {
        if (args.length > 1) {
            System.err.println("Usage: java ParcelWindows [events.tsv]");
            System.exit(2);
        }
        try (var reader = args.length == 0
                ? new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))
                : Files.newBufferedReader(Path.of(args[0]), StandardCharsets.UTF_8)) {
            process(reader, System.out);
        } catch (IllegalArgumentException | IOException error) {
            System.err.println(error.getMessage());
            System.exit(1);
        }
    }
}
