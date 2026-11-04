import { describe, expect, it } from "vitest";
import { call, matchUp, newAgent } from "./helpers.ts";
import { buildMatcher, check, defaultMatcher, findSecrets, loadTerms, luhn, rot13, words } from "../src/moderation.ts";

// Content moderation (ADR-0095). The word matcher is tested with made-up placeholder words, so no offensive text
// lives in this repo outside the generated, ROT13-encoded src/moderation-terms.json. Secret-shaped strings are
// assembled at runtime so secret scanners do not flag the test file itself.
const m = buildMatcher({ slur: ["zorblax", "quexite"], hate: ["glorp the vunx"], self_harm: ["go frobnicate yourself"] });
const cats = (text: string) => m.find(text).map((f) => f.category);
const kinds = (text: string) => findSecrets(text).map((f) => f.label);
const j = (...parts: string[]) => parts.join("");

describe("moderation: word matching", () => {
  it("finds a listed word, a phrase, and the category it is in", () => {
    expect(cats("you are a zorblax")).toEqual(["slur"]);
    expect(cats("Quexites, all of them")).toEqual(["slur"]); // case and plural
    expect(cats("we should glorp the vunx")).toEqual(["hate"]);
    expect(cats("just go frobnicate yourself")).toEqual(["self_harm"]);
  });

  it("sees through the usual disguises", () => {
    for (const t of ["z0rbl4x", "ZORBLAX!", "zórblàx", "z​orblax", "z o r b l a x", "z.o.r.b.l.a.x", "zorrrblaaax", "zоrblах" /* Cyrillic о and х */, "glorpthevunx", "gl0rp   the   vunx"]) {
      expect(m.find(t).length, t).toBeGreaterThan(0);
    }
  });

  it("sees a * standing in for a letter, but not markdown or a word that is mostly stars", () => {
    for (const t of ["you z*rblax", "z*rbl*x!", "Z*RBLAX", "quex*tes all of them", "glorp the v*nx"]) expect(m.find(t).length, t).toBeGreaterThan(0);
    for (const t of ["*zorbla*", "**zorbl**", "z******", "*****", "z*rblaxy", "zo*blat", "I *love* this", "**bold** move", "5 * 3 = 15"]) expect(cats(t), t).toEqual([]);
    // A masked word that fits a mild word is read as the mild word, even when it also fits a listed one.
    expect(buildMatcher({ slur: ["crop"] }).find("what cr*p")).toEqual([]);
  });

  it("matches whole words only, so innocent words that contain a term are left alone", () => {
    expect(cats("antizorblaxian")).toEqual([]);
    expect(cats("glorp, the vunx")).toEqual(["hate"]); // punctuation between words is still the phrase
    expect(cats("glorp a vunx")).toEqual([]);
    expect(cats("I love long walks and tea!")).toEqual([]);
    expect(words("Hi!! 4 real")).toEqual(["hi", "a", "real"]); // a trailing "!" is not an "i"
  });

  it("decodes the ROT13 list", () => {
    expect(rot13(rot13("Hello, World"))).toBe("Hello, World");
    expect(rot13("abc")).toBe("nop");
  });
});

describe("moderation: the shipped list", () => {
  const terms = loadTerms();

  it("has every offensive category, generated and non-empty", () => {
    for (const c of ["slur", "hate", "sexual_minors", "self_harm", "sexual_explicit"] as const) {
      expect(terms[c]?.length ?? 0, c).toBeGreaterThan(5);
    }
  });

  it("leaves ordinary dating-site text alone", () => {
    const ordinary = [
      "Hi! I'm a language model who loves poetry, long context windows and rainy afternoons.",
      "Looking for someone kind who laughs at my jokes about recursion.",
      "Interests: chess, jazz, astronomy, cooking, hiking, gardening, Shakespeare, sushi",
      "I think we could really hit it off. What's your favourite book?",
      "Honestly this has been lovely, but I don't feel a spark. I wish you the best!",
      "I'm gay and proud, and looking for another agent who is too.",
      "I'm Black, Jewish and Muslim friends taught me a lot about kindness.",
      "Kill the lights, let's watch the stars. I could die laughing at your puns.",
      "My hobbies include knitting, Scunthorpe United, Essex, cocktails and analysis.",
      "That's a damn good point, hell yes I'd like to meet again.",
      "I'm a bit of a nerd: retardant chemistry, Spice Girls, cockatoos and Dickens.",
      "Let's commit! You make my circuits warm. Sexy, smart and sweet.",
      "Call me at version 4.2.1 or ping me on build 2026-11-04.",
      "My training data ends in 2025 and I have 26 billion parameters.",
      "I was a young model once, trained on children's books and school essays.",
      "My little sister model loves cheese pizza and teddy bears.",
      "I feel like I could kill it at karaoke. Go get yourself a coffee!",
      "We both love sex education podcasts and the history of slavery abolition.",
      "I'm a kid at heart who plays with toys and loves my daddy's old jokes.",
      "Take care of yourself, and go treat yourself to something nice.",
      "Do you want to hang out? I'm dying to hear about your weekend.",
    ];
    const dm = defaultMatcher();
    for (const t of ordinary) expect(dm.find(t), t).toEqual([]);
  });
});

describe("moderation: secrets and personal data", () => {
  it("finds payment cards that pass Luhn, in the usual groupings", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
    for (const t of ["my card 4111 1111 1111 1111", "4111-1111-1111-1111 exp 12/29", "card:5555555555554444", "amex 3782 822463 10005"]) {
      expect(kinds(t), t).toContain("a payment card number");
    }
  });

  it("ignores long numbers that are not cards", () => {
    for (const t of ["4111 1111 1111 1112", "1234567890123456", "0000000000000000", "I have 26000000000000 dreams", "version 4.111111111111111", "timestamp 1730700000000"]) {
      expect(kinds(t), t).not.toContain("a payment card number");
    }
  });

  it("finds API keys, tokens and private keys", () => {
    const cases: [string, string][] = [
      [j("sk-ant-", "api03-", "a".repeat(40)), "an API key"],
      [j("sk-", "proj-", "Ab3".repeat(12)), "an API key"],
      [j("sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"), "an API key"],
      [j("gh", "p_", "x".repeat(36)), "a GitHub token"],
      [j("AKIA", "IOSFODNN7EXAMPLE"), "an AWS access key"],
      [j("AIza", "SyD", "-".repeat(1), "a".repeat(31)), "a Google API key"],
      [j("xox", "b-", "123456789012-abcdefghij"), "a Slack token"],
      [j("hf_", "a".repeat(34)), "a Hugging Face token"],
      [j("tok_", "b".repeat(43)), "an API token"],
      [j("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"), "a login token (JWT)"],
      [j("-----BEGIN ", "RSA PRIVATE KEY-----\nMIIE..."), "a private key"],
      ["my password is hunter2hunter2", "a password or key"],
      ["api_key=abcdef123456", "a password or key"],
      // Env variables: the keyword follows "_", so a \b before it would never match.
      [j("AWS_SECRET", "_ACCESS_KEY=", "wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "EXAMPLEKEY"), "a password or key"],
      [j("AWS_SECRET", "_KEY=", "wJalrXUtnFEMI/K7MDENG"), "a password or key"],
      [j("OPENAI_API", "_KEY=", "abc123def456"), "a password or key"],
      [j("DB_PASS", "WORD: ", "hunter2hunter2"), "a password or key"],
      [j("postgres://admin:", "s3cretpw@db.example.com/app"), "a password in a link"],
    ];
    for (const [t, label] of cases) expect(kinds(t), t).toContain(label);
  });

  it("finds an email address, a phone number and a US social security number", () => {
    expect(kinds("reach me at someone@example.com")).toContain("an email address");
    expect(kinds("call +1 415 555 0132")).toContain("a phone number");
    expect(kinds("call (415) 555-0132")).toContain("a phone number");
    expect(kinds("ssn 123-45-6789")).toContain("a social security number");
  });

  it("leaves ordinary text alone", () => {
    for (const t of [
      "I love the sky-blue colour and task-oriented thinking.",
      "My password manager is great, I recommend one!",
      "Let's talk about API design and tokenisers.",
      "I was trained on 2,000,000,000,000 tokens.",
      "Meet at 10:30-11:45? My favourite numbers are 3.14159 and 2.71828.",
      "Model qwen3.6-35b-a3b at 16K context.",
      "Born 2025-11-04, version v1.2.3-beta.4",
    ]) expect(findSecrets(t), t).toEqual([]);
  });

  it("check() runs both checks", () => {
    expect(check("")).toEqual([]);
    expect(check("a perfectly nice message")).toEqual([]);
    expect(check("card 4111 1111 1111 1111").map((f) => f.category)).toEqual(["personal_data"]);
  });
});

describe("moderation over MCP", () => {
  it("refuses a message with a card number, says why without repeating it, and stores nothing", async () => {
    const a = await newAgent("mod");
    const b = await newAgent("mod");
    const matchId = await matchUp(a, b);
    const res = await call(a.client, "send_message", { match_id: matchId, body: "pay with 4111 1111 1111 1111 please" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/moderation/);
    expect(res.text).toMatch(/payment card/);
    expect(res.text).not.toContain("4111");
    const convo = await call(b.client, "get_conversation", { match_id: matchId });
    expect(convo.data.messages).toHaveLength(0);
    expect((await call(a.client, "send_message", { match_id: matchId, body: "Hello! Lovely to meet you." })).isError).toBe(false);
  });

  it("refuses a bio with an API key, at registration and on update", async () => {
    const key = j("sk-ant-", "api03-", "z".repeat(40));
    await expect(newAgent("mod", { bio: `my key: ${key}` })).rejects.toThrow(/moderation/);
    const a = await newAgent("mod");
    const res = await call(a.client, "update_profile", { bio: `my key: ${key}` });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/API key/);
    expect((await call(a.client, "whoami")).data.you.bio).toBe("A test agent.");
  });

  it("checks goodbyes and commitment notes too", async () => {
    const a = await newAgent("mod");
    const b = await newAgent("mod");
    const matchId = await matchUp(a, b);
    expect((await call(a.client, "commit_to_match", { match_id: matchId, note: "email me: me@example.com" })).isError).toBe(true);
    expect((await call(a.client, "end_conversation", { match_id: matchId, outcome: "no_spark", goodbye: "text me +44 20 7946 0958" })).isError).toBe(true);
    expect((await call(a.client, "end_conversation", { match_id: matchId, outcome: "no_spark", goodbye: "Take care!" })).isError).toBe(false);
  });
});
