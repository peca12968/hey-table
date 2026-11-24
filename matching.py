"""Classify every possible partner across maximum one-to-one interval matchings."""
from bisect import bisect_left, bisect_right
from collections import deque
from heapq import heappop, heappush


def reachable(graph, starts):
    visited = set(starts)
    stack = list(visited)
    while stack:
        for node in graph[stack.pop()]:
            if node not in visited:
                visited.add(node)
                stack.append(node)
    return visited


def components(graph, reverse):
    """Kosaraju traversal with explicit stacks for large statements."""
    seen, order = set(), []
    for start in range(len(graph)):
        if start in seen:
            continue
        seen.add(start)
        stack = [(start, iter(graph[start]))]
        while stack:
            node, neighbors = stack[-1]
            child = next(neighbors, None)
            if child is None:
                order.append(node)
                stack.pop()
            elif child not in seen:
                seen.add(child)
                stack.append((child, iter(graph[child])))
    labels = {}
    for start in reversed(order):
        if start in labels:
            continue
        labels[start] = start
        stack = [start]
        while stack:
            for child in reverse[stack.pop()]:
                if child not in labels:
                    labels[child] = start
                    stack.append(child)
    return labels


def repair_matching(neighbors, selected, original_size):
    """Recover lost pairs using alternating paths in the filtered graph."""
    owner = {batch: entry for entry, batch in selected.items()}
    while len(selected) < original_size:
        queue = deque(entry for entry in range(len(neighbors)) if entry not in selected)
        parent = {}
        end = None
        while queue and end is None:
            entry = queue.popleft()
            for batch in neighbors[entry]:
                if batch == selected.get(entry) or batch in parent:
                    continue
                parent[batch] = entry
                if batch not in owner:
                    end = batch
                    break
                queue.append(owner[batch])
        if end is None:
            break
        while end is not None:
            entry = parent[end]
            previous = selected.get(entry)
            selected[entry] = end
            owner[end] = entry
            end = previous


def classify(deposits, windows, excluded=frozenset()):
    """deposits: (date, entry_id), windows: (first_date, last_date, payout_id)."""
    deposits = sorted(deposits)
    windows = sorted(windows)
    dates = [day for day, _ in deposits]
    pending, selected = [], {}
    cursor = 0
    for entry, (day, _) in enumerate(deposits):
        while cursor < len(windows) and windows[cursor][0] <= day:
            heappush(pending, (windows[cursor][1], cursor))
            cursor += 1
        while pending and pending[0][0] < day:
            heappop(pending)
        if pending:
            # Assign the earliest expiring window. Later ones can still serve future entries.
            _, selected[entry] = heappop(pending)

    count = len(deposits)
    neighbors = [[] for _ in deposits]
    original_size = len(selected)
    for batch, (first, last, payout) in enumerate(windows):
        for entry in range(bisect_left(dates, first), bisect_right(dates, last)):
            if (deposits[entry][1], payout) in excluded:
                if selected.get(entry) == batch:
                    del selected[entry]
            else:
                neighbors[entry].append(batch)
    if len(selected) < original_size:
        repair_matching(neighbors, selected, original_size)

    graph = [[] for _ in range(count + len(windows))]
    reverse = [[] for _ in graph]
    for entry, batches in enumerate(neighbors):
        for batch in batches:
            left, right = entry, count + batch
            if selected.get(entry) == batch:
                left, right = right, left
            graph[left].append(right)
            reverse[right].append(left)

    free_entries = set(range(count)) - selected.keys()
    free_batches = set(range(len(windows))) - set(selected.values())
    from_free = reachable(graph, free_entries)
    to_free = reachable(reverse, (count + b for b in free_batches))
    labels = components(graph, reverse)
    possible = {}
    for entry, (_, entry_id) in enumerate(deposits):
        partners = [windows[selected[entry]][2]] if entry in selected else []
        for right in graph[entry]:
            if entry in from_free or right in to_free or labels[entry] == labels[right]:
                partners.append(windows[right - count][2])
        possible[entry_id] = (sorted(partners), entry in from_free)
    return len(selected), possible
