export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const action = body.action || "check";

  if (action === "define") {
    const word = normalizeWord(body.word || "");
    if (!word) {
      return jsonResponse(400, { error: "Missing word" });
    }

    try {
      const result = await defineFromFran(word);
      return jsonResponse(200, result);
    } catch (error) {
      return jsonResponse(200, {
        exists: false,
        found: false,
        definitionFound: false,
        word,
        message: error.message || "Unknown error",
        lookupUrl: franLookupUrl(word)
      });
    }
  }

  const words = Array.isArray(body.words) ? body.words : [];
  if (!words.length) {
    return jsonResponse(400, { error: "Missing words array" });
  }

  const normalizedWords = [...new Set(words.map(normalizeWord).filter(Boolean))];
  const results = {};

  for (const word of normalizedWords) {
    try {
      results[word] = await checkFran(word);
    } catch (error) {
      results[word] = {
        exists: false,
        error: error.message || "Unknown error",
        lookupUrl: franLookupUrl(word)
      };
    }
  }

  return jsonResponse(200, { results });
}

function normalizeWord(value) {
  return String(value || "").trim().toLocaleLowerCase("sl").normalize("NFC");
}

function franLookupUrl(word) {
  return `https://fran.si/iskanje?Query=${encodeURIComponent(word)}&View=1`;
}

async function fetchFranHtml(word) {
  const lookupUrl = franLookupUrl(word);
  const response = await fetch(lookupUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ScrabbleWordCheck/1.0)"
    }
  });

  if (!response.ok) {
    throw new Error(`FRAN HTTP ${response.status}`);
  }

  const html = await response.text();
  return { html, lookupUrl };
}

function hasNoResults(html) {
  const lower = html.toLocaleLowerCase("sl");
  const noResultsPatterns = [
    "brez zadetkov",
    "vaše iskanje ni bilo uspešno",
    "vaše iskanje ni vrnilo rezultatov"
  ];
  return noResultsPatterns.some(pattern => lower.includes(pattern));
}

async function checkFran(word) {
  const { html, lookupUrl } = await fetchFranHtml(word);
  return {
    exists: !hasNoResults(html),
    lookupUrl
  };
}

async function defineFromFran(word) {
  const { html, lookupUrl } = await fetchFranHtml(word);
  const exists = !hasNoResults(html);

  if (!exists) {
    return {
      exists: false,
      found: false,
      definitionFound: false,
      word,
      message: "FRAN ni vrnil zadetka za to besedo.",
      lookupUrl
    };
  }

  const candidates = buildMeaningCandidates(html, word);
  const best = candidates.find(isValidMeaningCandidate);

  if (!best) {
    return {
      exists: true,
      found: true,
      definitionFound: false,
      word,
      meaning: "",
      message: "FRAN je našel besedo, vendar pomena ni bilo mogoče zanesljivo izluščiti. Beseda je kljub temu veljavna.",
      lookupUrl
    };
  }

  return {
    exists: true,
    found: true,
    definitionFound: true,
    word,
    meaning: best,
    lookupUrl
  };
}

function buildMeaningCandidates(html, word) {
  const candidates = [];

  // 1. Poskusi meta description, a jo filtriraj.
  const metaMatch =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"]+)["']/i) ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"]+)["']/i);

  if (metaMatch?.[1]) {
    candidates.push(cleanMeaning(decodeHtml(metaMatch[1])));
  }

  // 2. Poskusi ciljati pogostejše vsebinske bloke.
  const blockPatterns = [
    /<(article|main|section|div)[^>]*class=["'][^"']*(entry-content|content|article|result|geslo|definicija|definition)[^"']*["'][^>]*>([\s\S]{0,6000}?)<\/\1>/gi,
    /<(article|main|section|div)[^>]*id=["'][^"']*(content|article|results|geslo)[^"']*["'][^>]*>([\s\S]{0,6000}?)<\/\1>/gi
  ];

  for (const pattern of blockPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const cleaned = htmlToText(match[3]);
      candidates.push(...extractSentenceCandidates(cleaned, word));
    }
  }

  // 3. Fallback: iz celotnega HTML-ja naredi tekst in izlušči odlomke okoli besede.
  const fullText = htmlToText(html);
  candidates.push(...extractSentenceCandidates(fullText, word));

  return uniqueStrings(candidates)
    .map(cleanMeaning)
    .filter(Boolean);
}

function extractSentenceCandidates(text, word) {
  const out = [];
  const normalizedText = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalizedText) return out;

  const lower = normalizedText.toLocaleLowerCase("sl");
  const needle = normalizeWord(word);

  // Izreži več odlomkov okoli zadetkov.
  let fromIndex = 0;
  for (let i = 0; i < 4; i++) {
    const pos = lower.indexOf(needle, fromIndex);
    if (pos === -1) break;

    const snippet = normalizedText.slice(Math.max(0, pos - 80), Math.min(normalizedText.length, pos + 320));
    out.push(snippet);
    fromIndex = pos + needle.length;
  }

  // Dodaj tudi prve bolj normalne stavke iz vsebine.
  const sentenceLike = normalizedText
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  for (const s of sentenceLike.slice(0, 12)) {
    out.push(s);
  }

  return out;
}

function isValidMeaningCandidate(text) {
  const value = cleanMeaning(text);
  if (!value) return false;

  const lower = value.toLocaleLowerCase("sl");

  const blockedPatterns = [
    "ta stran uporablja piškotke",
    "piškot",
    "cookie",
    "google analytics",
    "google spoštoma",
    "spremljamo vedenje uporabnikov",
    "vaše nastavitve",
    "več o pasom",
    "odpri v fran",
    "iskanje",
    "prijava",
    "registracija",
    "zadetkov",
    "naloži več",
    "meni",
    "domov",
    "zrc sazu",
    "fran",
    "slovarji",
    "pravila rabe slovenščine"
  ];

  if (blockedPatterns.some(p => lower.includes(p))) return false;
  if (value.length < 12) return false;
  if (value.length > 320) return false;

  // Hočemo razlagalni tekst, ne navigacije ali naštevanja.
  const goodSignals = [
    "kar",
    "ki",
    "je",
    "so",
    "pomeni",
    "vrsta",
    "naprava",
    "predmet",
    "dejanje",
    "oseba",
    "snov",
    "rastlina",
    "žival",
    "del",
    "navadno",
    "zlasti"
  ];

  const hasGoodSignal = goodSignals.some(s => lower.includes(` ${s} `) || lower.startsWith(`${s} `));
  if (!hasGoodSignal) return false;

  return true;
}

function htmlToText(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function cleanMeaning(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:;,.]+/, "")
    .replace(/[\s\-–—:;,.]+$/, "")
    .trim()
    .slice(0, 320);
}

function uniqueStrings(values) {
  return [...new Set(values.map(v => String(v || "").trim()).filter(Boolean))];
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&raquo;/g, "»")
    .replace(/&laquo;/g, "«");
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}
