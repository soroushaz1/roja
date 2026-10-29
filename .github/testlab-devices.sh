#!/bin/sh
# Which real phones Test Lab runs the app on, picked from its catalogue as it stands
# today rather than written down here, since models come and go:
#
#   gcloud firebase test android models list --format=json | sh .github/testlab-devices.sh
#
# prints one --device value per line (model=…,version=…), at most four phones, each
# chosen for something the emulator cannot show:
#   - a Samsung Galaxy A or M, the mid-range phones most of the mirror's visitors hold
#     (any Samsung if there is none), on its newest Android;
#   - a Xiaomi, Redmi or POCO, whose own camera and GPU drivers differ again;
#   - a Google Pixel on its newest Android, the reference;
#   - the phone with the oldest Android the catalogue still has (8, the app's minimum,
#     if it is there), on that Android.
# Only physical phones that run ARM code and are not marked for removal are considered.
# A group the catalogue has nothing for is left out, and a phone picked twice for the
# same Android counts once.
set -eu
jq -r '
  def maker: (.manufacturer // .brand // "") | ascii_downcase;
  def newest: max_by(.versions[-1]) | "model=\(.id),version=\(.versions[-1])";

  [ .[]
    | select(.form == "PHYSICAL" and (.formFactor // "PHONE") == "PHONE")
    | select(((.tags // []) | map(startswith("deprecated")) | any) | not)
    | select(((.supportedAbis // []) | length == 0)
             or any(.supportedAbis[]; . == "arm64-v8a" or . == "armeabi-v7a"))
    | .versions = ([.supportedVersionIds[]? | tonumber? | select(. >= 26)] | sort)
    | select(.versions | length > 0)
  ] as $phones
  | ($phones | map(select(maker == "samsung"))) as $samsung
  | ($samsung | map(select((.name // "") | test("Galaxy [AM][0-9]")))) as $midrange
  | [
      (if ($midrange | length) > 0 then $midrange | newest
       elif ($samsung | length) > 0 then $samsung | newest else empty end),
      ($phones | map(select(maker | test("^(xiaomi|redmi|poco)$"))) | select(length > 0) | newest),
      ($phones | map(select(maker == "google")) | select(length > 0) | newest),
      ($phones | select(length > 0) | min_by(.versions[0]) | "model=\(.id),version=\(.versions[0])")
    ]
  | reduce .[] as $d ([]; if index([$d]) then . else . + [$d] end)
  | .[]
'
