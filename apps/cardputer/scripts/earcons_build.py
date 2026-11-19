"""PlatformIO pre-build: generate immutable PCM inside the ignored build tree."""
from pathlib import Path
import runpy

Import("env")
output = Path(env.subst("$BUILD_DIR")) / "cabin-generated"
recipe = Path(env.subst("$PROJECT_DIR")) / "scripts" / "earcons_wave.py"
runpy.run_path(str(recipe))["write_header"](output / "earcons_pcm.h")
env.Append(CPPPATH=[str(output)])
