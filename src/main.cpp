#include <algorithm>
#include <fstream>
#include <iostream>
#include <limits>
#include <queue>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using Matrix = std::vector<std::vector<int>>;
constexpr int infinity = std::numeric_limits<int>::max() / 2;

struct Floor {
    int width = 0;
    int height = 0;
    std::string cells;
    std::vector<int> stops;  // Depot first, then all picks in row-major order.
};

Floor read_floor(std::istream& input, int max_picks) {
    Floor floor;
    int depot = -1;
    std::string row;
    while (std::getline(input, row)) {
        if (!row.empty() && row.back() == '\r') row.pop_back();
        if (row.empty() || row.size() > 128 || floor.height >= 128)
            throw std::runtime_error("floor must contain 1 to 128 rows and columns");
        if (floor.height == 0) floor.width = static_cast<int>(row.size());
        if (static_cast<int>(row.size()) != floor.width) throw std::runtime_error("unequal row widths");
        for (char tile : row) {
            int pos = static_cast<int>(floor.cells.size());
            if (tile == 'D') {
                if (depot >= 0) throw std::runtime_error("multiple depots");
                depot = pos;
            } else if (tile == '*') {
                floor.stops.push_back(pos);
                if (static_cast<int>(floor.stops.size()) > max_picks)
                    throw std::runtime_error("too many picks for this mode (limit " + std::to_string(max_picks) + ")");
            } else if (tile != '#' && tile != '.') {
                throw std::runtime_error("unknown tile on row " + std::to_string(floor.height + 1));
            }
            floor.cells.push_back(tile);
        }
        ++floor.height;
    }
    if (input.bad()) throw std::runtime_error("could not read floor");
    if (depot < 0) throw std::runtime_error("missing depot");
    floor.stops.insert(floor.stops.begin(), depot);
    return floor;
}

struct Paths {
    Matrix distance;  // Shortest walking distance between stops.
    Matrix parent;    // One BFS tree per stop for reconstructing the actual walk.
};

Paths aisle_paths(const Floor& floor) {
    Paths paths;
    for (int origin : floor.stops) {
        std::vector<int> distance(floor.cells.size(), -1), parent(floor.cells.size(), -1);
        std::queue<int> pending;
        pending.push(origin);
        distance[origin] = 0;
        while (!pending.empty()) {
            int pos = pending.front();
            pending.pop();
            int row = pos / floor.width, col = pos % floor.width;
            auto visit = [&](int r, int c) {
                if (r < 0 || r >= floor.height || c < 0 || c >= floor.width) return;
                int next = r * floor.width + c;
                if (floor.cells[next] == '#' || distance[next] >= 0) return;
                parent[next] = pos;
                distance[next] = distance[pos] + 1;
                pending.push(next);
            };
            visit(row - 1, col);
            visit(row, col - 1);
            visit(row, col + 1);
            visit(row + 1, col);
        }
        std::vector<int> between;
        for (int target : floor.stops) {
            if (distance[target] < 0)
                throw std::runtime_error("unreachable pick at row " + std::to_string(target / floor.width + 1)
                                         + ", column " + std::to_string(target % floor.width + 1));
            between.push_back(distance[target]);
        }
        paths.distance.push_back(std::move(between));
        paths.parent.push_back(std::move(parent));
    }
    return paths;
}

std::vector<int> nearest_order(const Matrix& distance) {
    int n = static_cast<int>(distance.size());
    std::vector<bool> visited(n);
    std::vector<int> order{0};
    for (int i = 1; i < n; ++i) {
        int best = -1;
        for (int j = 1; j < n; ++j)
            if (!visited[j] && (best < 0 || distance[order.back()][j] < distance[order.back()][best]))
                best = j;
        visited[best] = true;
        order.push_back(best);
    }
    order.push_back(0);
    return order;
}

std::vector<int> exact_order(const Matrix& distance) {
    int n = static_cast<int>(distance.size()) - 1;
    if (n == 0) return {0, 0};
    int full = (1 << n) - 1;
    // cost[mask,last] starts at the depot and ends at pick 'last'.
    std::vector<int> cost((full + 1) * n, infinity), previous(cost.size(), -1);
    for (int j = 0; j < n; ++j) cost[(1 << j) * n + j] = distance[0][j + 1];
    for (int mask = 1; mask <= full; ++mask) {
        for (int last = 0; last < n; ++last) {
            int current = cost[mask * n + last];
            if (current == infinity) continue;
            for (int j = 0; j < n; ++j) {
                if (mask & (1 << j)) continue;
                int index = (mask | (1 << j)) * n + j;
                int proposal = current + distance[last + 1][j + 1];
                if (proposal < cost[index]) {
                    cost[index] = proposal;
                    previous[index] = last;
                }
            }
        }
    }
    int last = -1, shortest = infinity;
    for (int j = 0; j < n; ++j) {
        int total = cost[full * n + j] + distance[j + 1][0];
        if (total < shortest) {
            last = j;
            shortest = total;
        }
    }
    std::vector<int> order{0};
    int mask = full;
    while (last >= 0) {
        order.push_back(last + 1);
        int prior = previous[mask * n + last];
        mask ^= 1 << last;
        last = prior;
    }
    order.push_back(0);
    std::reverse(order.begin(), order.end());
    return order;
}

std::vector<int> expand_walk(const Floor& floor, const Paths& paths, const std::vector<int>& order) {
    std::vector<int> walk{floor.stops[0]};
    for (std::size_t i = 1; i < order.size(); ++i) {
        int from = order[i - 1], end = floor.stops[order[i]];
        std::vector<int> backwards;
        for (int pos = end; pos != floor.stops[from]; pos = paths.parent[from][pos])
            backwards.push_back(pos);
        walk.insert(walk.end(), backwards.rbegin(), backwards.rend());
    }
    return walk;
}

void write_coords(const std::vector<int>& cells, int width) {
    std::cout << '[';
    for (std::size_t i = 0; i < cells.size(); ++i) {
        int pos = cells[i];
        if (i) std::cout << ',';
        std::cout << '[' << pos / width + 1 << ',' << pos % width + 1 << ']';
    }
    std::cout << ']';
}

int main(int argc, char** argv) {
    if (argc == 2 && std::string(argv[1]) == "--help") {
        std::cout << "pick-route [--nearest] [FILE|-]\n";
        return 0;
    }
    try {
        bool nearest = argc > 1 && std::string(argv[1]) == "--nearest";
        int arg = nearest ? 2 : 1;
        if (argc > arg + 1) throw std::runtime_error("expected at most one floor file");
        std::ifstream file;
        bool use_file = argc > arg && std::string(argv[arg]) != "-";
        if (use_file) {
            file.open(argv[arg]);
            if (!file) throw std::runtime_error("cannot open floor file");
        }
        Floor floor = read_floor(use_file ? static_cast<std::istream&>(file) : std::cin, nearest ? 64 : 14);
        Paths paths = aisle_paths(floor);
        auto order = nearest ? nearest_order(paths.distance) : exact_order(paths.distance);
        auto walk = expand_walk(floor, paths, order);
        std::vector<int> picks;
        std::vector<bool> collected(floor.cells.size());
        for (int pos : walk) {
            if (floor.cells[pos] == '*' && !collected[pos]) {
                collected[pos] = true;
                picks.push_back(pos);
            }
        }
        std::cout << "{\"method\":\"" << (nearest ? "nearest" : "exact") << "\",\"steps\":" << walk.size() - 1
                  << ",\"pick_order\":";
        write_coords(picks, floor.width);
        std::cout << ",\"walk\":";
        write_coords(walk, floor.width);
        std::cout << "}\n";
        return std::cout ? 0 : 1;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 2;
    }
}
