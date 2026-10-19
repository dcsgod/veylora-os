import sys

import pytest

from backend.config import Config
from backend.execution.runner import CommandRejected, ProcessRunner


@pytest.fixture
def runner(tmp_path):
    return ProcessRunner(Config(data_dir=tmp_path / "data"))


async def test_rejects_unknown_executable_and_bad_args(runner, tmp_path):
    with pytest.raises(CommandRejected):
        await runner.run("bash", ["-c", "echo hi"], tmp_path, tmp_path)
    with pytest.raises(CommandRejected):
        await runner.run("python", "-c print(1)", tmp_path, tmp_path)  # type: ignore[arg-type]
    with pytest.raises(CommandRejected):
        await runner.run("python", ["-c", "print(1)"], tmp_path.parent, tmp_path)
    with pytest.raises(CommandRejected):
        runner.build_env(None, {"BAD;NAME": "1"}, "python")


async def test_runs_argv_without_shell_and_redacts(runner, tmp_path):
    secret = "ghp_" + "b" * 36
    res = await runner.run("python", ["-c", "import sys; print(sys.argv[1]); print('" + secret + "')", "a; echo injected"],
                           tmp_path, tmp_path, sandbox_home=tmp_path / "home")
    assert res.ok
    assert res.stdout.splitlines()[0] == "a; echo injected"
    assert secret not in res.stdout


async def test_timeout_kills_process(runner, tmp_path):
    res = await runner.run("python", ["-c", "import time; time.sleep(30)"], tmp_path, tmp_path, timeout_s=0.5)
    assert res.timed_out and not res.ok and res.duration_ms < 15000


async def test_output_is_capped(runner, tmp_path):
    res = await runner.run("python", ["-c", "print('x' * 100000)"], tmp_path, tmp_path, max_output=1000)
    assert res.truncated and len(res.stdout) <= 1000


def test_env_does_not_leak_secrets(runner, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-leak")
    env = runner.build_env(None, None, "python")
    assert "OPENAI_API_KEY" not in env and env["GIT_TERMINAL_PROMPT"] == "0"
    assert sys.platform != "win32" or "SYSTEMROOT" in env
