#!/usr/bin/env bash
set -euo pipefail
python -m venv --system-site-packages /root/indic-venv
/root/indic-venv/bin/pip install 'git+https://github.com/huggingface/parler-tts.git@d108732cd57788ec86bc857d99a6cabd66663d68' scipy soundfile
/root/indic-venv/bin/pip freeze > /root/indic-pip-freeze.txt
