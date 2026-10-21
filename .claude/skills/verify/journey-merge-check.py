import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def verify(output):
    source = Path(__file__).resolve().parent
    env = {
        "PATH": os.environ["PATH"],
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_AUTHOR_NAME": "Verify",
        "GIT_AUTHOR_EMAIL": "verify@example.invalid",
        "GIT_COMMITTER_NAME": "Verify",
        "GIT_COMMITTER_EMAIL": "verify@example.invalid",
    }
    evidence = {"layout": "files" if (source / "journeys").is_dir() else "shared", "merges": []}
    with tempfile.TemporaryDirectory(prefix="hn-journey-merge-") as run:
        root = Path(run)

        def git(*args, check=True):
            return subprocess.run(
                ["git", "-c", "core.hooksPath=/dev/null", *args],
                cwd=root, env=env, capture_output=True, text=True, check=check,
            )

        git("init", "--quiet", "--template=", "--initial-branch=base")
        target = root / ".claude/skills/verify"
        target.mkdir(parents=True)
        shutil.copyfile(source / "SKILL.md", target / "SKILL.md")
        if (source / "journeys").is_dir():
            shutil.copytree(source / "journeys", target / "journeys")
        git("add", ".")
        git("commit", "--quiet", "-m", "Synthetic verification layout")
        for name in ("alpha", "beta"):
            git("checkout", "--quiet", "-b", name, "base")
            content = f"## Synthetic {name} journey\n\nObserve {name} independently.\n"
            if evidence["layout"] == "files":
                (target / "journeys" / f"synthetic-{name}.md").write_text(content)
            else:
                with (target / "SKILL.md").open("a") as file:
                    file.write("\n" + content)
            git("add", ".")
            git("commit", "--quiet", "-m", f"Add synthetic {name} journey")
        for first, second in (("alpha", "beta"), ("beta", "alpha")):
            merged = git("merge-tree", "--write-tree", first, second, check=False)
            result = {"order": [first, second], "exitCode": merged.returncode,
                      "output": merged.stdout, "stderr": merged.stderr}
            if merged.returncode == 0:
                tree = merged.stdout.splitlines()[0]
                for name in ("alpha", "beta"):
                    path = f".claude/skills/verify/journeys/synthetic-{name}.md"
                    actual = git("show", f"{tree}:{path}").stdout
                    assert actual == f"## Synthetic {name} journey\n\nObserve {name} independently.\n"
                actual = git("show", f"{tree}:.claude/skills/verify/SKILL.md").stdout
                assert actual == (source / "SKILL.md").read_text()
                result["bothJourneysPreserved"] = True
                result["sharedSetupUnchanged"] = True
            evidence["merges"].append(result)
    encoded = json.dumps(evidence, indent=2) + "\n"
    if output:
        Path(output).write_text(encoded)
    print(encoded, end="")
    assert all(result["exitCode"] == 0 for result in evidence["merges"]), (
        "Independent journey additions conflict; see both merge-tree results"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    verify(parser.parse_args().output)
