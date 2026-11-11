#!/bin/bash
# sheet.sh <out> <files...>  — контактный лист 2 колонки
out=$1; shift; n=$#; rows=$(( (n+1)/2 ))
args=(); for f in "$@"; do args+=(-i "$f"); done
ffmpeg -y -loglevel error "${args[@]}" -filter_complex "$(for i in $(seq 0 $((n-1))); do printf '[%d:v]scale=960:540[v%d];' $i $i; done)$(for i in $(seq 0 $((n-1))); do printf '[v%d]' $i; done)xstack=inputs=$n:layout=$(for i in $(seq 0 $((n-1))); do printf '%d_%d' $(( (i%2)*960 )) $(( (i/2)*540 )); [ $i -lt $((n-1)) ] && printf '|'; done)" -q:v 3 "$out"
