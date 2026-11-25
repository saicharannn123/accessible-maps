#!/usr/bin/env bash
# Runs on the rented build server (see .github/workflows/build-world-map.yml).
# Downloads the latest OpenStreetMap planet, brings it up to today with the daily change files,
# builds the whole-world OpenMapTiles PMTiles with Planetiler and uploads it to Cloudflare R2.
# Needs: R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET PLANETILER_VERSION
#        HCLOUD_TOKEN SERVER_ID (only for the safety switch below)
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Safety switch: if anything hangs, the server deletes itself after 7 hours so it can't keep billing.
nohup bash -c "sleep 25200; curl -s -X DELETE -H 'Authorization: Bearer $HCLOUD_TOKEN' https://api.hetzner.cloud/v1/servers/$SERVER_ID" >/dev/null 2>&1 &

apt-get update -qq
apt-get install -y -qq openjdk-21-jre-headless aria2 rclone python3-venv >/dev/null
python3 -m venv /opt/osm && /opt/osm/bin/pip install -q osmium

mkdir -p /data && cd /data
echo "== Downloading the OpenStreetMap planet"
aria2c -q -x 8 -s 16 --file-allocation=none -o planet.osm.pbf \
  https://ftp5.gwdg.de/pub/misc/openstreetmap/planet.openstreetmap.org/pbf/planet-latest.osm.pbf \
  https://ftp.fau.de/osm-planet/pbf/planet-latest.osm.pbf \
  https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf

echo "== Applying OpenStreetMap edits up to today"
/opt/osm/bin/pyosmium-up-to-date -v --size 30000 planet.osm.pbf || echo "Could not apply all edits; building from the weekly planet."

echo "== Building tiles"
curl -fsSL -o planetiler.jar "https://github.com/onthegomap/planetiler/releases/download/v${PLANETILER_VERSION}/planetiler.jar"
java -Xmx100g -jar planetiler.jar \
  --osm-path=planet.osm.pbf --bounds=world --download --download-threads=10 --http-retries=5 \
  --nodemap-type=array --storage=mmap --force \
  --output=world.pmtiles --maxzoom=14 \
  --name="BM Locator" --attribution='© OpenStreetMap contributors · © OpenMapTiles'
rm -f planet.osm.pbf

name="bm-locator-world-$(date -u +%Y%m%d).pmtiles"
echo "== Uploading $name ($(du -h world.pmtiles | cut -f1)) to R2"
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
  RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
rclone copyto world.pmtiles "r2:$R2_BUCKET/$name" --s3-upload-concurrency 16 --s3-chunk-size 256M --stats 5m --stats-one-line
echo "$name" > latest.txt
rclone copyto latest.txt "r2:$R2_BUCKET/latest.txt" --header-upload "Cache-Control: no-cache"

# Keep this build and the one before it (open maps may still be reading it); remove older ones.
rclone lsf "r2:$R2_BUCKET" --include 'bm-locator-world-*.pmtiles' | sort | head -n -2 | while read -r old; do
  rclone deletefile "r2:$R2_BUCKET/$old"
done
echo "== Done: $name"
