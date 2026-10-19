from __future__ import annotations

from collections import defaultdict, deque
from typing import Iterable, Mapping


class CycleError(ValueError):
    def __init__(self, cycle: list[str]):
        self.cycle = cycle
        super().__init__("dependency cycle detected: " + " -> ".join(cycle))


class UnknownDependencyError(ValueError):
    pass


def validate_graph(nodes: Iterable[str], edges: Mapping[str, Iterable[str]]) -> list[str]:
    """Validate a dependency graph (node -> its dependencies) and return a topological order.

    Raises UnknownDependencyError for dangling references and CycleError for cycles.
    """
    node_list = list(nodes)
    node_set = set(node_list)
    if len(node_set) != len(node_list):
        dupes = sorted({n for n in node_list if node_list.count(n) > 1})
        raise ValueError(f"duplicate task keys: {dupes}")
    deps = {n: list(dict.fromkeys(edges.get(n, ()))) for n in node_list}
    for n, ds in deps.items():
        for d in ds:
            if d not in node_set:
                raise UnknownDependencyError(f"task {n!r} depends on unknown task {d!r}")
            if d == n:
                raise CycleError([n, n])

    indegree = {n: len(deps[n]) for n in node_list}
    dependents: dict[str, list[str]] = defaultdict(list)
    for n, ds in deps.items():
        for d in ds:
            dependents[d].append(n)
    order_index = {n: i for i, n in enumerate(node_list)}
    queue = deque(sorted((n for n in node_list if indegree[n] == 0), key=order_index.__getitem__))
    order: list[str] = []
    while queue:
        n = queue.popleft()
        order.append(n)
        for m in sorted(dependents[n], key=order_index.__getitem__):
            indegree[m] -= 1
            if indegree[m] == 0:
                queue.append(m)
    if len(order) != len(node_list):
        raise CycleError(_find_cycle({n: deps[n] for n in node_list if indegree[n] > 0}))
    return order


def _find_cycle(deps: Mapping[str, list[str]]) -> list[str]:
    color: dict[str, int] = {}
    stack: list[str] = []

    def visit(n: str) -> list[str] | None:
        color[n] = 1
        stack.append(n)
        for d in deps.get(n, []):
            if d not in deps:
                continue
            if color.get(d) == 1:
                return stack[stack.index(d):] + [d]
            if color.get(d) is None and (found := visit(d)):
                return found
        stack.pop()
        color[n] = 2
        return None

    for n in deps:
        if color.get(n) is None and (found := visit(n)):
            return found
    return list(deps)[:2]


def layered_layout(order: list[str], edges: Mapping[str, Iterable[str]], x_gap: float = 280, y_gap: float = 110) -> dict[str, tuple[float, float]]:
    """Deterministic left-to-right layout: column = longest dependency depth, row = stable order."""
    depth: dict[str, int] = {}
    for n in order:
        ds = list(edges.get(n, ()))
        depth[n] = 1 + max((depth[d] for d in ds), default=-1)
    rows: dict[int, int] = defaultdict(int)
    positions: dict[str, tuple[float, float]] = {}
    for n in order:
        col = depth[n]
        positions[n] = (col * x_gap, rows[col] * y_gap)
        rows[col] += 1
    return positions


def descendants(start: str, dependents: Mapping[str, Iterable[str]]) -> set[str]:
    seen: set[str] = set()
    stack = list(dependents.get(start, ()))
    while stack:
        n = stack.pop()
        if n in seen:
            continue
        seen.add(n)
        stack.extend(dependents.get(n, ()))
    return seen
