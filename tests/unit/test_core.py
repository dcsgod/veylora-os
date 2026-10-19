import pytest

from backend.orchestration.dag import CycleError, UnknownDependencyError, descendants, layered_layout, validate_graph
from backend.orchestration.states import InvalidTransition, TaskStatus as S, assert_transition, can_transition
from backend.security.paths import PathViolation, resolve_within, safe_relative
from backend.security.redact import MASK, redact_text, redact_value
from backend.security.scan import scan_text


def test_transitions():
    assert can_transition(S.PENDING, S.READY)
    assert can_transition(S.RUNNING, S.WAITING_FOR_APPROVAL)
    assert not can_transition(S.PENDING, S.RUNNING)
    assert not can_transition(S.COMPLETED, S.READY)
    with pytest.raises(InvalidTransition):
        assert_transition(S.COMPLETED, S.FAILED)


def test_validate_graph_orders_and_rejects_bad_graphs():
    order = validate_graph(["a", "b", "c", "d"], {"b": ["a"], "c": ["a"], "d": ["b", "c"]})
    assert order == ["a", "b", "c", "d"]
    with pytest.raises(CycleError) as exc:
        validate_graph(["a", "b", "c"], {"a": ["c"], "b": ["a"], "c": ["b"]})
    assert set(exc.value.cycle) == {"a", "b", "c"}
    with pytest.raises(CycleError):
        validate_graph(["a"], {"a": ["a"]})
    with pytest.raises(UnknownDependencyError):
        validate_graph(["a"], {"a": ["missing"]})
    with pytest.raises(ValueError):
        validate_graph(["a", "a"], {})


def test_layout_and_descendants():
    edges = {"b": ["a"], "c": ["b"], "d": ["a"]}
    pos = layered_layout(["a", "b", "d", "c"], edges)
    assert pos["a"][0] == 0 and pos["b"][0] == pos["d"][0] > 0 and pos["c"][0] > pos["b"][0]
    assert pos["b"][1] != pos["d"][1]
    assert descendants("a", {"a": ["b", "d"], "b": ["c"]}) == {"b", "c", "d"}


@pytest.mark.parametrize("bad", ["", "/etc/passwd", "C:/Windows", "..", "a/../../b", "\\\\server\\share", "con.txt",
                                 "a/nul", "trailing. ", ".git/config", "a<b", "x\x00y"])
def test_safe_relative_rejects(bad):
    with pytest.raises(PathViolation):
        safe_relative(bad)


def test_safe_relative_normalises_and_resolve_within(tmp_path):
    assert safe_relative("src\\./app.mjs").as_posix() == "src/app.mjs"
    (tmp_path / "src").mkdir()
    assert resolve_within(tmp_path, "src/x.txt").parent == (tmp_path / "src").resolve()
    with pytest.raises(PathViolation):
        resolve_within(tmp_path, "../outside.txt")


def test_redaction():
    token = "ghp_" + "a" * 36
    assert token not in redact_text(f"push with {token}")
    assert redact_text("Authorization: Bearer abcdefghijklmnopqrstuvwxyz") .endswith(MASK)
    assert "hunter22secret" not in redact_text("password=hunter22secret")
    out = redact_value({"api_key": "value-123", "nested": [{"token": "x" * 10}], "count": 3, "note": "plain"})
    assert out == {"api_key": MASK, "nested": [{"token": MASK}], "count": 3, "note": "plain"}


def test_static_scan_rules():
    rules = {f.rule for f in scan_text("a.mjs", "const r = eval(x);\nimport cp from 'node:child_process';\nserver.listen(1, '0.0.0.0')")}
    assert {"js-eval", "js-child-process", "listen-all-interfaces"} <= rules
    assert not scan_text("a.mjs", "const evaluate = (x) => x; obj.eval(1);")
    assert not [f for f in scan_text("a.py", "eval(x)") if f.rule.startswith("js-")]
    assert any(f.rule == "py-shell-true" for f in scan_text("run.py", "subprocess.run(cmd, shell=True)"))
