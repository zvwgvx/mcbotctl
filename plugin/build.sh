#!/usr/bin/env bash
# Build the plugin, then copy it straight into the test server's plugins directory.
set -e
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
JAVAC=/usr/lib/jvm/java-21-openjdk-amd64/bin/javac
JAR=/usr/lib/jvm/java-21-openjdk-amd64/bin/jar
CP="$ROOT/server/data/cache/patched_1.8.8.jar"
OUT=build

rm -rf "$OUT" && mkdir -p "$OUT/classes"
echo "compile (release 8, classpath patched_1.8.8.jar)..."
"$JAVAC" --release 8 -nowarn -cp "$CP" -d "$OUT/classes" $(find src -name '*.java')
cp plugin.yml config.yml "$OUT/classes/"
"$JAR" cf "$OUT/McbotctlParty.jar" -C "$OUT/classes" .
mkdir -p "$ROOT/server/data/plugins"
cp "$OUT/McbotctlParty.jar" "$ROOT/server/data/plugins/"
echo "done -> server/data/plugins/McbotctlParty.jar"
