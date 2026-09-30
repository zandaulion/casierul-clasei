#!/usr/bin/env python3
"""Render the user services with paths from the checkout that runs deploy.sh."""

from pathlib import Path
import os
import sys
import tempfile


def unit_quote(value: Path) -> str:
    text = str(value)
    if "\n" in text or "\r" in text or "\0" in text:
        raise ValueError("Systemd paths cannot contain control characters.")
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"'


def unit_path(value: Path) -> str:
    """Escape a scalar path directive, where surrounding quotes are significant."""
    rendered = []
    for byte in os.fsencode(value):
        character = chr(byte)
        if character in "/._-" or "0" <= character <= "9" or "A" <= character <= "Z" or "a" <= character <= "z":
            rendered.append(character)
        elif character == "%":
            rendered.append("%%")
        else:
            rendered.append(f"\\x{byte:02x}")
    return "".join(rendered)


def write_unit(source: Path, destination: Path, replacements: dict[str, str]) -> None:
    rendered = source.read_text()
    for old, new in replacements.items():
        if old not in rendered:
            raise RuntimeError(f"Expected directive missing from {source.name}: {old}")
        rendered = rendered.replace(old, new)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(rendered)
        temporary.chmod(0o644)
        temporary.replace(destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def executable(value: str, label: str) -> Path:
    path = Path(value).resolve()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise SystemExit(f"{label} is not an executable file: {path}")
    return path


if len(sys.argv) != 5:
    raise SystemExit("Usage: install-systemd.py PROJECT_DIR DESTINATION NODE_BIN PYTHON_BIN")

project = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]).resolve()
node = executable(sys.argv[3], "Node.js")
python = executable(sys.argv[4], "Python")
source = project / "deploy"
destination.mkdir(parents=True, exist_ok=True, mode=0o755)

common = {
    "WorkingDirectory=%h/projects/casierul-clasei": f"WorkingDirectory={unit_path(project)}",
}
write_unit(source / "casierul-clasei.service", destination / "casierul-clasei.service", {
    **common,
    "ExecStart=/usr/bin/node %h/projects/casierul-clasei/server/index.mjs":
        f"ExecStart={unit_quote(node)} {unit_quote(project / 'server/index.mjs')}",
})
write_unit(source / "casierul-clasei-backup.service", destination / "casierul-clasei-backup.service", {
    "ExecStart=/usr/bin/node %h/projects/casierul-clasei/scripts/backup.mjs":
        f"ExecStart={unit_quote(node)} {unit_quote(project / 'scripts/backup.mjs')}",
})
write_unit(source / "casierul-clasei-preview.service", destination / "casierul-clasei-preview.service", {
    **common,
    "ExecStart=/usr/bin/python3 -m http.server 8018 --bind 127.0.0.1 --directory %h/projects/casierul-clasei/preview":
        f"ExecStart={unit_quote(python)} -m http.server 8018 --bind 127.0.0.1 --directory {unit_quote(project / 'preview')}",
})
write_unit(source / "casierul-clasei-backup.timer", destination / "casierul-clasei-backup.timer", {})

print(f"Systemd user units rendered for {project} with {node}.")
