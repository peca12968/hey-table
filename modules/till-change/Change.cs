internal static class Change
{
    internal const int MaximumTarget = 100_000;
    private const long Unreachable = long.MaxValue;

    // For one denomination, choose between zero and limit pieces of the same cost.
    // Each residue modulo value is independent. Its sliding window stores candidate
    // predecessors in ascending order of previous[amount] - step * cost.
    private static (long[] Scores, int[] Taken) AddBand(
        long[] previous, int value, int limit, long cost)
    {
        int target = previous.Length - 1;
        var next = new long[previous.Length];
        var taken = new int[previous.Length];
        int[] candidates = new int[target / value + 1];
        for (int residue = 0; residue < value; residue++)
        {
            int head = 0, tail = 0;
            long Key(int step) => previous[residue + step * value] - step * cost;
            int lastStep = (target - residue) / value;
            for (int step = 0; step <= lastStep; step++)
            {
                int amount = residue + step * value;
                while (head < tail && candidates[head] < step - limit) head++;
                if (previous[amount] != Unreachable)
                {
                    while (head < tail && Key(candidates[tail - 1]) >= Key(step)) tail--;
                    candidates[tail++] = step;
                }
                next[amount] = Unreachable;
                if (head == tail) continue;
                int best = candidates[head];
                taken[amount] = step - best;
                next[amount] = Key(best) + step * cost;
            }
        }
        return (next, taken);
    }

    public static int[]? Find(int[] values, int[] available, int[] reserve, int target)
    {
        if (target < 0 || target > MaximumTarget)
            throw new ArgumentException($"Change must be between 0 and {MaximumTarget} units.");
        var scores = new long[target + 1];
        Array.Fill(scores, Unreachable);
        scores[0] = 0;
        var stages = new List<(int Index, int[] Taken)>();
        for (int i = values.Length - 1; i >= 0; i--)
        {
            if (values[i] > target || available[i] == 0) continue;
            int free = Math.Max(0, available[i] - reserve[i]);
            void Add(int count, long cost)
            {
                if (count == 0) return;
                var band = AddBand(scores, values[i], Math.Min(count, target / values[i]), cost);
                scores = band.Scores;
                stages.Add((i, band.Taken));
            }
            Add(free, 1);
            // Even the most piece-heavy exact solution has at most target pieces.
            Add(available[i] - free, target + 2L);
        }
        if (scores[target] == Unreachable) return null;
        var change = new int[values.Length];
        for (int i = stages.Count - 1; i >= 0; i--)
        {
            var (index, taken) = stages[i];
            int count = taken[target];
            change[index] += count;
            target -= count * values[index];
        }
        return change;
    }
}
