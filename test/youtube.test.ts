import assert from "node:assert/strict";
import test from "node:test";
import { __test__, parseSubtitles } from "../src/fetch/youtube.ts";

test("parseSubtitles: basic VTT parsing", () => {
  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:04.000
Hello world

00:00:05.000 --> 00:00:08.000
This is a test
`;
  const result = parseSubtitles(vtt);
  assert.ok(result.includes("[00:00:01]"));
  assert.ok(result.includes("Hello world"));
  assert.ok(result.includes("This is a test"));
});

test("parseSubtitles: deduplicates repeated lines", () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Hello world

00:00:02.000 --> 00:00:04.000
Hello world

00:00:05.000 --> 00:00:08.000
Different text
`;
  const result = parseSubtitles(vtt);
  const count = (result.match(/Hello world/g) || []).length;
  assert.equal(count, 1, "Duplicate lines should be removed");
});

test("parseSubtitles: strips HTML tags", () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<c.colorE5E5E5>Hello</c> <b>world</b>
`;
  const result = parseSubtitles(vtt);
  assert.ok(result.includes("Hello world"));
  assert.ok(!result.includes("<c."));
  assert.ok(!result.includes("<b>"));
});

test("parseSubtitles: groups into paragraphs at >30s gaps", () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
First cluster line 1

00:00:10.000 --> 00:00:15.000
First cluster line 2

00:01:00.000 --> 00:01:05.000
Second cluster line 1

00:01:10.000 --> 00:01:15.000
Second cluster line 2

00:02:30.000 --> 00:02:35.000
Third cluster line 1
`;
  const result = parseSubtitles(vtt);
  const paragraphs = result.split("\n\n").filter(Boolean);
  assert.ok(paragraphs.length >= 3, `Expected >= 3 paragraphs, got ${paragraphs.length}`);
});

test("parseSubtitles: handles SRT format", () => {
  const srt = `1
00:00:01,000 --> 00:00:04,000
Hello SRT

2
00:00:05,000 --> 00:00:08,000
Second line
`;
  const result = parseSubtitles(srt);
  assert.ok(result.includes("Hello SRT"));
  assert.ok(result.includes("Second line"));
});

test("parseSubtitles: returns empty on empty input", () => {
  assert.equal(parseSubtitles(""), "");
  assert.equal(parseSubtitles("WEBVTT\n\n"), "");
});

test("classifyYouTubeUrl: keeps single videos on the transcript path", () => {
  const target = __test__.classifyYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123");
  assert.deepEqual(target, {
    kind: "video",
    videoId: "dQw4w9WgXcQ",
    videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
});

test("classifyYouTubeUrl: treats playlists as collections", () => {
  const target = __test__.classifyYouTubeUrl("https://www.youtube.com/playlist?list=PL123");
  assert.deepEqual(target, {
    kind: "collection",
    collectionKind: "playlist",
    fetchUrl: "https://www.youtube.com/playlist?list=PL123",
    tab: null,
  });
});

test("classifyYouTubeUrl: normalizes bare handle channels to /videos", () => {
  const target = __test__.classifyYouTubeUrl("https://www.youtube.com/@SkillUp");
  assert.deepEqual(target, {
    kind: "collection",
    collectionKind: "channel",
    fetchUrl: "https://www.youtube.com/@SkillUp/videos",
    tab: "videos",
  });
});

test("classifyYouTubeUrl: keeps explicit channel tabs", () => {
  const target = __test__.classifyYouTubeUrl("https://www.youtube.com/@Google/playlists");
  assert.deepEqual(target, {
    kind: "collection",
    collectionKind: "channel",
    fetchUrl: "https://www.youtube.com/@Google/playlists",
    tab: "playlists",
  });
});

test("formatDuration: renders compact human-readable durations", () => {
  assert.equal(__test__.formatDuration(16), "16s");
  assert.equal(__test__.formatDuration(2030), "33m 50s");
  assert.equal(__test__.formatDuration(7567), "2h 6m 7s");
  assert.equal(__test__.formatDuration(null), null);
});

test("renderCollectionContent: includes truncation notice and full-list path", () => {
  const markdown = __test__.renderCollectionContent(
    {
      kind: "collection",
      collectionKind: "playlist",
      fetchUrl: "https://www.youtube.com/playlist?list=PL123",
      tab: null,
    },
    {
      title: "This Week In Videogames",
      channel: "Skill Up",
      entries: [
        {
          id: "c12xpZJlqZ4",
          title: "Report: Xbox boss says Gamepass too expensive",
          url: "https://www.youtube.com/watch?v=c12xpZJlqZ4",
          duration: 2030,
        },
        {
          id: "PL456",
          title: "Nested playlist",
          url: "https://www.youtube.com/playlist?list=PL456",
        },
      ],
    },
    {
      shownCount: 2,
      totalCount: 269,
      fullListPath: "/tmp/full-playlist.md",
      truncated: true,
      includeFullListPath: true,
    },
  );

  assert.ok(markdown.includes("**YouTube Playlist:** This Week In Videogames"));
  assert.ok(markdown.includes("**Owner:** Skill Up"));
  assert.ok(markdown.includes("**Full list file:** /tmp/full-playlist.md"));
  assert.ok(markdown.includes("**Items shown:** 2 of 269"));
  assert.ok(markdown.includes("**Truncated list:** first 2 of 269, rest at /tmp/full-playlist.md"));
  assert.ok(markdown.includes("## Videos"));
  assert.ok(markdown.includes("1. Report: Xbox boss says Gamepass too expensive"));
  assert.ok(markdown.includes("Duration: 33m 50s"));
  assert.ok(markdown.includes("https://www.youtube.com/playlist?list=PL456"));
});

test("renderCollectionContent: labels channel tabs explicitly", () => {
  const markdown = __test__.renderCollectionContent(
    {
      kind: "collection",
      collectionKind: "channel",
      fetchUrl: "https://www.youtube.com/@Google/shorts",
      tab: "shorts",
    },
    {
      channel: "Google",
      webpage_url: "https://www.youtube.com/@Google/shorts",
      entries: [
        {
          id: "SWBKAaBWEI4",
          title: "Could Steph Curry win on an elastic court?",
          url: "https://www.youtube.com/shorts/SWBKAaBWEI4",
        },
      ],
    },
    {
      shownCount: 1,
      totalCount: 1,
      fullListPath: "/tmp/google-shorts.md",
      truncated: false,
      includeFullListPath: true,
    },
  );

  assert.ok(markdown.includes("**YouTube Channel:** Google"));
  assert.ok(markdown.includes("**Tab:** Shorts"));
  assert.ok(markdown.includes("**Full list file:** /tmp/google-shorts.md"));
  assert.ok(markdown.includes("**Items shown:** 1"));
  assert.ok(!markdown.includes("**Truncated list:**"));
  assert.ok(markdown.includes("## Shorts"));
  assert.ok(markdown.includes("https://www.youtube.com/shorts/SWBKAaBWEI4"));
});

test("buildCollectionFilePath: stays stable for the same collection", () => {
  const first = __test__.buildCollectionFilePath(
    {
      kind: "collection",
      collectionKind: "channel",
      fetchUrl: "https://www.youtube.com/@SkillUp/videos",
      tab: "videos",
    },
    {
      id: "UCZ7AeeVbyslLM_8-nVy2B8Q",
      title: "Skill Up - Videos",
      channel: "Skill Up",
    },
  );
  const second = __test__.buildCollectionFilePath(
    {
      kind: "collection",
      collectionKind: "channel",
      fetchUrl: "https://www.youtube.com/@SkillUp/videos",
      tab: "videos",
    },
    {
      id: "UCZ7AeeVbyslLM_8-nVy2B8Q",
      title: "Skill Up Renamed",
      channel: "Skill Up",
    },
  );

  assert.equal(first, second);
  assert.ok(first.endsWith("channel-videos--ucz7aeevbysllm_8-nvy2b8q.md"));
});
