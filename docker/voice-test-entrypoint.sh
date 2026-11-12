#!/bin/sh
set -eu
pulseaudio --start --exit-idle-time=-1 --log-target=stderr
pactl load-module module-null-sink sink_name=voice_test >/dev/null
pactl set-default-sink voice_test
exec "$@"
