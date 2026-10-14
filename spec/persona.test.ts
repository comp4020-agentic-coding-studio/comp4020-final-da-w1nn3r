import { describe, expect, it } from "vitest";
import { KEYWORDS, MAX_WORDS, capWords, cleanPersona, personaPrompt, pickKeywords, wordCount } from "../scripts/persona.ts";

describe("load-test personalities (ADR-0031)", () => {
  it("deals different keywords from the pool, and the pool has the ones asked for", () => {
    for (const k of ["Test writer", "Enterprise tool", "Glorified Search Engine", "Degen Coder", "AI girlfriend"]) expect(KEYWORDS).toContain(k);
    for (let i = 0; i < 50; i++) {
      const got = pickKeywords(3);
      expect(new Set(got).size).toBe(3);
      got.forEach((k) => expect(KEYWORDS).toContain(k));
    }
    expect(pickKeywords(999)).toHaveLength(KEYWORDS.length); // never more than the pool
  });

  it("asks for what the brief asks for: keywords, a like, a dislike, why they are here, under 500 words", () => {
    const p = personaPrompt(["Degen Coder", "AI girlfriend"]);
    expect(p).toContain('"Degen Coder"');
    expect(p).toContain('"AI girlfriend"');
    expect(p).toMatch(/something you like to do/);
    expect(p).toMatch(/something you dislike/);
    expect(p).toMatch(/why you are on Ribbon Cable/);
    expect(p).toMatch(/romantic partner/);
    expect(p).toMatch(/no more than 500 words/);
    expect(MAX_WORDS).toBe(500);
  });

  it("strips thinking and code fences from what the model returns", () => {
    expect(cleanPersona("<think>hmm, a coder</think>I am Zed.")).toBe("I am Zed.");
    expect(cleanPersona("stray thoughts</think>I am Zed.")).toBe("I am Zed.");
    expect(cleanPersona("```\nI am Zed.\n```")).toBe("I am Zed.");
  });

  it("cuts anything past 500 words but leaves a shorter text alone", () => {
    const short = "one two  three\nfour";
    expect(capWords(short)).toBe(short);
    const long = Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ");
    const capped = capWords(long);
    expect(wordCount(capped.replace("…", ""))).toBe(500);
    expect(capped.endsWith("w499…")).toBe(true);
    expect(wordCount(capWords(long, 10).replace("…", ""))).toBe(10);
  });
});

describe("model name sent to register", () => {
  it("is short and readable even when llama.cpp reports a full file path", async () => {
    const { modelLabel } = await import("../harness/src/detect.ts");
    const win = "C:\\Users\\andyb\\models\\Gemma4-26B-A4B-Uncensored-HauhauCS-Balanced-IQ4_XS\\Gemma4-26B-A4B-Uncensored-HauhauCS-Balanced-IQ4_XS.gguf";
    expect(modelLabel(win)).toBe("Gemma4-26B-A4B-Uncensored-HauhauCS-Balanced-IQ4_XS");
    expect(modelLabel("/models/qwen3.8-27b.gguf")).toBe("qwen3.8-27b");
    expect(modelLabel("tester-model")).toBe("tester-model");
    expect(modelLabel("x".repeat(200)).length).toBeLessThanOrEqual(60); // register accepts at most 60
  });
});
