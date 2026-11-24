#include <algorithm>
#include <charconv>
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
    std::vector<int> weights{0};  // Indexed by stop, with zero for the depot.
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
            } else if (tile == '*' || (tile >= '1' && tile <= '9')) {
                floor.stops.push_back(pos);
                floor.weights.push_back(tile == '*' ? 1 : tile - '0');
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

struct Search {
    std::vector<int> distance;
    std::vector<int> parent;
};

Search search_from(const Floor& floor, int origin) {
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
    return {std::move(distance), std::move(parent)};
}

Paths aisle_paths(Floor& floor, bool reachable_only, int max_picks, std::vector<int>& unreachable) {
    Search depot = search_from(floor, floor.stops[0]);
    std::size_t kept = 1;
    for (std::size_t i = 1; i < floor.stops.size(); ++i) {
        int cell = floor.stops[i];
        if (depot.distance[cell] < 0) {
            if (!reachable_only)
                throw std::runtime_error("unreachable pick at row " + std::to_string(cell / floor.width + 1)
                                         + ", column " + std::to_string(cell % floor.width + 1));
            unreachable.push_back(cell);
        } else {
            floor.stops[kept] = cell;
            floor.weights[kept] = floor.weights[i];
            ++kept;
        }
    }
    if (static_cast<int>(kept) - 1 > max_picks)
        throw std::runtime_error("too many picks for this mode (limit " + std::to_string(max_picks) + ")");
    floor.stops.resize(kept);
    floor.weights.resize(kept);
    Paths paths;
    for (int origin : floor.stops) {
        Search tree = origin == floor.stops[0] ? std::move(depot) : search_from(floor, origin);
        std::vector<int> between;
        for (int target : floor.stops) between.push_back(tree.distance[target]);
        paths.distance.push_back(std::move(between));
        paths.parent.push_back(std::move(tree.parent));
    }
    return paths;
}

using Orders = std::vector<std::vector<int>>;

struct Cart {
    int slots;
    int max_load;

    bool fits(int count, int weight) const { return count <= slots && weight <= max_load; }
};

Orders nearest_orders(const Matrix& distance, const std::vector<int>& weights, Cart cart) {
    int n = static_cast<int>(distance.size());
    std::vector<bool> visited(n);
    Orders orders;
    int remaining = n - 1;
    while (remaining > 0) {
        std::vector<int> order{0};
        int load = 0;
        while (true) {
            int best = -1;
            int next_count = static_cast<int>(order.size());  // Includes the starting depot.
            for (int j = 1; j < n; ++j) {
                if (visited[j] || !cart.fits(next_count, load + weights[j])) continue;
                if (best < 0 || distance[order.back()][j] < distance[order.back()][best]) best = j;
            }
            if (best < 0) break;
            visited[best] = true;
            load += weights[best];
            order.push_back(best);
            --remaining;
        }
        order.push_back(0);
        orders.push_back(std::move(order));
    }
    return orders;
}

Orders exact_orders(const Matrix& distance, const std::vector<int>& weights, Cart cart) {
    int n = static_cast<int>(distance.size()) - 1;
    if (n == 0) return {};
    int full = (1 << n) - 1;
    // cost[mask,last] starts at the depot and ends at pick 'last'.
    std::vector<int> cost((full + 1) * n, infinity), previous(cost.size(), -1);
    std::vector<int> size(full + 1), load(full + 1), tour(full + 1, infinity), endpoint(full + 1, -1);
    for (int j = 0; j < n; ++j) {
        int bit = 1 << j;
        for (int mask = 0; mask < bit; ++mask) {
            size[mask | bit] = size[mask] + 1;
            load[mask | bit] = load[mask] + weights[j + 1];
        }
    }
    for (int j = 0; j < n; ++j) cost[(1 << j) * n + j] = distance[0][j + 1];
    for (int mask = 1; mask <= full; ++mask) {
        if (!cart.fits(size[mask], load[mask])) continue;
        for (int last = 0; last < n; ++last) {
            int current = cost[mask * n + last];
            if (current == infinity) continue;
            int round_trip = current + distance[last + 1][0];
            if (round_trip < tour[mask]) {
                tour[mask] = round_trip;
                endpoint[mask] = last;
            }
            for (int j = 0; j < n; ++j) {
                if ((mask & (1 << j)) || !cart.fits(size[mask] + 1, load[mask] + weights[j + 1])) continue;
                int index = (mask | (1 << j)) * n + j;
                int proposal = current + distance[last + 1][j + 1];
                if (proposal < cost[index]) {
                    cost[index] = proposal;
                    previous[index] = last;
                }
            }
        }
    }
    // Partition remaining picks. Anchor each candidate trip on the lowest
    // remaining bit to avoid enumerating permutations of the same trips.
    std::vector<int> first_trip(full + 1);
    if (cart.fits(n, load[full])) {
        first_trip[full] = full;
    } else {
        using Score = std::pair<int, int>;  // minimize steps, then number of trips
        std::vector<Score> best(full + 1, {infinity, infinity});
        best[0] = {0, 0};
        for (int mask = 1; mask <= full; ++mask) {
            int anchor = mask & -mask;
            int optional = mask ^ anchor;
            for (int sub = optional; ; sub = (sub - 1) & optional) {
                int trip = sub | anchor;
                if (cart.fits(size[trip], load[trip])) {
                    const auto& rest = best[mask ^ trip];
                    Score proposal{tour[trip] + rest.first, 1 + rest.second};
                    if (proposal < best[mask]) {
                        best[mask] = proposal;
                        first_trip[mask] = trip;
                    }
                }
                if (sub == 0) break;
            }
        }
    }
    Orders orders;
    for (int remaining = full; remaining; remaining ^= first_trip[remaining]) {
        int mask = first_trip[remaining];
        std::vector<int> order{0};
        for (int last = endpoint[mask]; last >= 0; ) {
            order.push_back(last + 1);
            int prior = previous[mask * n + last];
            mask ^= 1 << last;
            last = prior;
        }
        order.push_back(0);
        std::reverse(order.begin(), order.end());
        orders.push_back(std::move(order));
    }
    return orders;
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

struct Route {
    std::vector<int> walk;
    std::vector<int> picks;
    int load = 0;
};

Route make_trip(const Floor& floor, const Paths& paths, const std::vector<int>& order) {
    Route trip{expand_walk(floor, paths, order), {}};
    std::vector<bool> assigned(floor.cells.size());
    for (int stop : order) {
        if (stop != 0) assigned[floor.stops[stop]] = true;
        trip.load += floor.weights[stop];
    }
    for (int pos : trip.walk) {
        if (assigned[pos]) {
            trip.picks.push_back(pos);
            assigned[pos] = false;
        }
    }
    return trip;
}

void write_route_fields(const Route& route, int width) {
    std::cout << "\"steps\":" << route.walk.size() - 1 << ",\"pick_order\":";
    write_coords(route.picks, width);
    std::cout << ",\"walk\":";
    write_coords(route.walk, width);
}

int positive_arg(int& arg, int argc, char** argv, const std::string& option) {
    if (++arg < argc) {
        std::string value = argv[arg];
        int result = 0;
        auto end = value.data() + value.size();
        auto parsed = std::from_chars(value.data(), end, result);
        if (parsed.ec == std::errc{} && parsed.ptr == end && result > 0) return result;
    }
    throw std::runtime_error(option + " expects a positive integer");
}

int main(int argc, char** argv) {
    if (argc == 2 && std::string(argv[1]) == "--help") {
        std::cout << "pick-route [--nearest] [--capacity ITEMS] [--max-load WEIGHT] "
                     "[--close ROW COL]... [--reachable-only] [FILE|-]\n";
        return 0;
    }
    try {
        bool nearest = false;
        bool reachable_only = false;
        std::vector<std::pair<int, int>> closures;
        int capacity = 0;
        int max_load = 0;
        int arg = 1;
        while (arg < argc) {
            std::string option = argv[arg];
            if (option == "--nearest" && !nearest) {
                nearest = true;
            } else if (option == "--reachable-only" && !reachable_only) {
                reachable_only = true;
            } else if (option == "--close") {
                int row = positive_arg(arg, argc, argv, option);
                int col = positive_arg(arg, argc, argv, option);
                closures.emplace_back(row, col);
            } else if (option == "--capacity" || option == "--max-load") {
                int& limit = option == "--capacity" ? capacity : max_load;
                if (limit) throw std::runtime_error("duplicate " + option);
                limit = positive_arg(arg, argc, argv, option);
            } else {
                break;
            }
            ++arg;
        }
        if (argc > arg + 1) throw std::runtime_error("expected at most one floor file");
        std::ifstream file;
        bool use_file = argc > arg && std::string(argv[arg]) != "-";
        if (use_file) {
            file.open(argv[arg]);
            if (!file) throw std::runtime_error("cannot open floor file");
        }
        int max_picks = nearest ? 64 : 14;
        Floor floor = read_floor(use_file ? static_cast<std::istream&>(file) : std::cin,
                                 reachable_only ? 128 * 128 : max_picks);
        for (const auto& [row, col] : closures) {
            if (row > floor.height || col > floor.width) throw std::runtime_error("closure outside floor");
            int cell = (row - 1) * floor.width + col - 1;
            if (cell == floor.stops[0]) throw std::runtime_error("cannot close depot");
            floor.cells[cell] = '#';
        }
        std::vector<int> unreachable;
        Paths paths = aisle_paths(floor, reachable_only, max_picks, unreachable);
        Cart cart{capacity ? capacity : infinity, max_load ? max_load : infinity};
        for (std::size_t i = 1; i < floor.stops.size(); ++i) {
            if (floor.weights[i] > cart.max_load) {
                int pos = floor.stops[i];
                throw std::runtime_error("pick exceeds max load at row " + std::to_string(pos / floor.width + 1)
                                         + ", column " + std::to_string(pos % floor.width + 1));
            }
        }
        auto orders = nearest ? nearest_orders(paths.distance, floor.weights, cart)
                              : exact_orders(paths.distance, floor.weights, cart);
        Route combined{{floor.stops[0]}, {}};
        std::vector<Route> trips;
        for (const auto& order : orders) {
            auto trip = make_trip(floor, paths, order);
            combined.walk.insert(combined.walk.end(), trip.walk.begin() + 1, trip.walk.end());
            combined.picks.insert(combined.picks.end(), trip.picks.begin(), trip.picks.end());
            trips.push_back(std::move(trip));
        }
        std::cout << "{\"method\":\"" << (nearest ? "nearest" : "exact") << "\",";
        write_route_fields(combined, floor.width);
        if (reachable_only) {
            std::cout << ",\"complete\":" << (unreachable.empty() ? "true" : "false") << ",\"unreachable\":";
            write_coords(unreachable, floor.width);
        }
        if (capacity) std::cout << ",\"capacity\":" << capacity;
        if (max_load) std::cout << ",\"max_load\":" << max_load;
        if (capacity || max_load) {
            std::cout << ",\"trips\":[";
            for (std::size_t i = 0; i < trips.size(); ++i) {
                if (i) std::cout << ',';
                std::cout << '{';
                write_route_fields(trips[i], floor.width);
                if (max_load) std::cout << ",\"load\":" << trips[i].load;
                std::cout << '}';
            }
            std::cout << ']';
        }
        std::cout << "}\n";
        return std::cout ? 0 : 1;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 2;
    }
}
