import argparse
import json
from pathlib import Path
import re


def verify(output):
    skill = Path(__file__).resolve().parent
    routes = {
        "codex-desktop-repo-project-registration.md":
            "codex-desktop-opening-journey-human-operated-gui.md",
        "web-schedule-strip-g7b.md": "../SKILL.md#launch",
        "sdk-message-derived-column-upgrade-journey.md": "../SKILL.md#launch",
    }
    missing = []
    for source, target in routes.items():
        file = skill / "journeys" / source
        links = re.findall(r"\[[^\]]+\]\(([^)]+)\)", file.read_text())
        if target not in links:
            missing.append(f"{source} does not link to {target}")
            continue
        path, _, anchor = target.partition("#")
        destination = file.parent / path
        if not destination.is_file():
            missing.append(f"{source} links to a missing file: {target}")
        elif anchor and f"## {anchor.title()}\n" not in destination.read_text():
            missing.append(f"{source} links to a missing section: {target}")
    design = skill.parents[2] / "docs/design/in-app-artifacts.md"
    section = design.read_text().split("## Verification and implementation slices\n", 1)[1]
    instruction = section.strip().split("\n\n", 1)[0]
    if ".claude/skills/verify/journeys/" not in instruction:
        missing.append("Artifact design still sends authors to the shared skill")
    delivery = skill.parents[2] / "docs/design/work-delivery-guarantees.md"
    instruction = delivery.read_text().split("For each implementation slice", 1)[1]
    if ".claude/skills/verify/journeys/" not in instruction.split("\n\n", 1)[0]:
        missing.append("Work-delivery design still sends new journeys to the shared skill")
    evidence = {"checkedJourneyRoutes": len(routes), "design": str(design), "missing": missing}
    encoded = json.dumps(evidence, indent=2) + "\n"
    if output:
        Path(output).write_text(encoded)
    print(encoded, end="")
    assert not missing, "Standalone journey navigation is incomplete"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    verify(parser.parse_args().output)
