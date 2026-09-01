#!/usr/bin/env sh
# Find out whether your cameras actually expose RTSP, and on which path.
#
# Run this ON THE BRIDGE BOX (same LAN as the cameras):
#   sh discover-rtsp.sh 192.168.1.0/24 admin yourpassword
#
# V720-family cameras are cloud/P2P first. Many also run an RTSP server; some
# do not. This tells you which of yours do, in about a minute.

set -eu
SUBNET="${1:-192.168.1.0/24}"
USER="${2:-admin}"
PASS="${3:-}"

command -v nmap >/dev/null || { echo "install nmap first (apt install nmap)"; exit 1; }
command -v ffprobe >/dev/null || { echo "install ffmpeg first (apt install ffmpeg)"; exit 1; }

echo "Scanning $SUBNET for RTSP (554) and ONVIF (8000/8899)..."
HOSTS=$(nmap -p 554,8000,8899 --open -oG - "$SUBNET" | awk '/Ports:/{print $2}')

[ -n "$HOSTS" ] || { echo "No hosts answering on 554/8000/8899. Your cameras are almost certainly P2P-only — see the README for what to do instead."; exit 0; }

# The paths cheap Chinese cams actually use, most common first.
PATHS="onvif1 onvif2 live/ch00_0 live/ch0 11 12 stream1 h264Preview_01_main cam/realmonitor?channel=1&subtype=0 video1"

for HOST in $HOSTS; do
	echo ""
	echo "=== $HOST ==="
	FOUND=""
	for P in $PATHS; do
		URL="rtsp://${USER}:${PASS}@${HOST}:554/${P}"
		if ffprobe -v error -rtsp_transport tcp -timeout 4000000 \
			-show_entries stream=codec_name,width,height -of csv=p=0 "$URL" 2>/dev/null; then
			echo "  WORKS -> rtsp://${USER}:***@${HOST}:554/${P}"
			FOUND=1
			break
		fi
	done
	[ -n "$FOUND" ] || echo "  no RTSP path responded (wrong credentials, or P2P-only firmware)"
done

echo ""
echo "Copy any WORKS line into bridge/mediamtx.yml as a path source."
