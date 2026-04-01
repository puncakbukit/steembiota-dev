// ============================================================
// blockchain.js
// Steem blockchain interactions — pure async helpers.
// Extended with SteemBiota creature publishing.
// No Vue, no DOM dependencies.
// ============================================================

// ---- SteemBiota app URL (used in post bodies to link back to creature pages) ----
const APP_URL = "https://puncakbukit.github.io/steembiota";

// ---- RPC nodes & fallback ----

const RPC_NODES = [
  "https://api.steemit.com",
  "https://api.justyy.com",
  "https://steemd.steemworld.org",
  "https://api.steem.fans"
];

let currentRPCIndex = 0;

function setRPC(index) {
  currentRPCIndex = index;
  steem.api.setOptions({ url: RPC_NODES[index] });
  console.log("Switched RPC to:", RPC_NODES[index]);
}

// Safe API wrapper with automatic RPC fallback on error.
function callWithFallback(apiCall, args, callback, attempt = 0) {
  apiCall(...args, (err, result) => {
    if (!err) return callback(null, result);
    console.warn("RPC error on", RPC_NODES[currentRPCIndex], err);
    const nextIndex = currentRPCIndex + 1;
    if (nextIndex >= RPC_NODES.length) return callback(err, null);
    setRPC(nextIndex);
    callWithFallback(apiCall, args, callback, attempt + 1);
  });
}

// Promise wrapper around callWithFallback.
function callWithFallbackAsync(apiCall, args) {
  return new Promise((resolve, reject) => {
    callWithFallback(apiCall, args, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// Run an array of async tasks with at most `concurrency` in-flight at once.
// Used by fetchCreaturesOwnedBy, fetchAccessoriesOwnedBy, and
// fetchNotificationsForUser to avoid flooding free public RPC nodes
// with hundreds of simultaneous reply fetches.
async function _throttledMap(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    worker
  );
  await Promise.all(workers);
  return results;
}

// ---- Account helpers ----

// Fetch a single Steem account and extract its profile metadata.
function fetchAccount(username) {
  return new Promise(resolve => {
    if (!username) return resolve(null);
    steem.api.getAccounts([username], (err, result) => {
      if (err || !result || !result.length) return resolve(null);
      const account = result[0];
      let profile = {};
      try {
        profile = JSON.parse(
          account.posting_json_metadata || account.json_metadata
        ).profile || {};
      } catch {}
      resolve({
        username:     account.name,
        profileImage: profile.profile_image || "",
        displayName:  profile.name || account.name,
        about:        profile.about || "",
        coverImage:   profile.cover_image || ""
      });
    });
  });
}

// Fetch multiple Steem accounts in one API call.
// Returns a map of { username: profileData } for all found accounts.
function fetchAccountsBatch(usernames) {
  return new Promise(resolve => {
    if (!usernames || !usernames.length) return resolve({});
    steem.api.getAccounts(usernames, (err, result) => {
      if (err || !result) return resolve({});
      const map = {};
      for (const account of result) {
        let profile = {};
        try {
          profile = JSON.parse(
            account.posting_json_metadata || account.json_metadata
          ).profile || {};
        } catch {}
        map[account.name] = {
          username:     account.name,
          profileImage: profile.profile_image || "",
          displayName:  profile.name || account.name,
          about:        profile.about || "",
          coverImage:   profile.cover_image || ""
        };
      }
      resolve(map);
    });
  });
}

// ---- Post / comment helpers ----

function fetchPost(author, permlink) {
  return callWithFallbackAsync(steem.api.getContent, [author, permlink]);
}

function fetchReplies(author, permlink) {
  return callWithFallbackAsync(steem.api.getContentReplies, [author, permlink]);
}

function fetchAllReplies(author, permlink) {
  return new Promise(resolve => {
    const collected = [];
    function recurse(author, permlink, done) {
      callWithFallback(
        steem.api.getContentReplies,
        [author, permlink],
        (err, replies) => {
          if (err || !replies || replies.length === 0) return done();
          let pending = replies.length;
          replies.forEach(reply => {
            collected.push(reply);
            recurse(reply.author, reply.permlink, () => {
              if (--pending === 0) done();
            });
          });
        }
      );
    }
    recurse(author, permlink, () => resolve(collected));
  });
}

function fetchPostsByTag(tag, limit = 20) {
  return callWithFallbackAsync(
    steem.api.getDiscussionsByCreated,
    [{ tag, limit }]
  );
}

// Paginated version — use start_author + start_permlink as a cursor.
// The first result will duplicate the cursor post; callers should slice(1).
function fetchPostsByTagPaged(tag, limit, startAuthor, startPermlink) {
  return callWithFallbackAsync(
    steem.api.getDiscussionsByCreated,
    [{ tag, limit, start_author: startAuthor, start_permlink: startPermlink }]
  );
}

function fetchPostsByUser(username, limit = 50) {
  return callWithFallbackAsync(
    steem.api.getDiscussionsByBlog,
    [{ tag: username, limit }]
  );
}

// ---- Keychain helpers ----

function keychainPost(
  username, title, body,
  parentPermlink, parentAuthor,
  jsonMetadata, permlink, tags,
  callback
) {
  const meta = typeof jsonMetadata === "string"
    ? JSON.parse(jsonMetadata)
    : { ...jsonMetadata };
  if (tags && tags.length) meta.tags = tags;

  steem_keychain.requestPost(
    username, title, body,
    parentPermlink, parentAuthor,
    JSON.stringify(meta),
    permlink, "",
    callback
  );
}

// Request a Keychain signature to verify account ownership (login).
function keychainLogin(username, callback) {
  steem_keychain.requestSignBuffer(
    username,
    "Login to SteemBiota",
    "Posting",
    callback
  );
}

// ---- SteemBiota — publish a creature to the blockchain ----
//
// genome          : object produced by generateGenome()
// unicodeArt      : string produced by buildUnicodeArt()
// creatureName    : string produced by generateFullName()
// age             : number — days since creation (calculateAge)
// lifecycleStage  : string — "Juvenile" | "Fertile Adult" | "Elder" | "Fossil"
// callback        : (response) => { response.success, response.message }
function publishCreature(username, genome, unicodeArt, creatureName, age, lifecycleStage, title, genusName, callback) {
  const permlink = buildPermlink(title);
  const sexLabel = genome.SX === 0 ? "Male" : "Female";
  const genusDisplay = genusName ? `${genusName} (GEN ${genome.GEN})` : `GEN ${genome.GEN}`;

  const creaturePageUrl = `${APP_URL}/#/@${username}/${permlink}`;

  const body =
    `## 🧬 ${creatureName}\n\n` +
    `**Sex:** ${sexLabel}  \n` +
    `**Age:** ${age} day${age === 1 ? "" : "s"}  \n` +
    `**Status:** ${lifecycleStage}  \n` +
    `**Genus:** ${genusDisplay}  \n` +
    `**Hue:** ${genome.CLR}°  \n` +
    `**Lifespan:** ${genome.LIF} days  \n` +
    `**Fertile:** Day ${genome.FRT_START}–${genome.FRT_END}  \n` +
    `**Mutation:** MUT ${genome.MUT}  \n\n` +
    `\`\`\`\n${unicodeArt}\n\`\`\`\n\n` +
    `\`\`\`genome\n${JSON.stringify(genome, null, 2)}\n\`\`\`\n\n` +
    `---\n🔗 [View on SteemBiota](${creaturePageUrl})\n\n` +
    `*Published via [SteemBiota — Immutable Evolution](${APP_URL})*`;

  const jsonMetadata = {
    app: "steembiota/1.0",
    steembiota: {
      version: "1.0",
      genome,
      name: creatureName,
      age,
      lifecycleStage,
      type: "founder"
    }
  };

  const nameParts = creatureName.split(" ");
  const lastName  = (nameParts[0] || "").toLowerCase();
  const firstName = (nameParts[1] || "").toLowerCase();
  const genusTag  = (genusName || lastName).toLowerCase();
  const sexTag    = genome.SX === 0 ? "male" : "female";
  const tags      = [...new Set(["steembiota", "gaming", "evolution", genusTag, firstName, lastName, sexTag].filter(Boolean))];

  jsonMetadata.tags = tags;

  keychainPost(
    username, title, body,
    "steembiota", "",
    jsonMetadata, permlink,
    tags,
    (response) => callback({ ...response, permlink })
  );
}

// ---- SteemBiota — publish a bred offspring to the blockchain ----
//
// breedInfo: { mutated, speciated, parentA: {author,permlink}, parentB: {author,permlink} }
function publishOffspring(username, genome, unicodeArt, creatureName, breedInfo, title, genusName, callback) {
  const permlink = buildPermlink(title);
  const sexLabel = genome.SX === 0 ? "Male" : "Female";
  const genusDisplay = genusName ? `${genusName} (GEN ${genome.GEN})` : `GEN ${genome.GEN}`;
  const pA = breedInfo.parentA;
  const pB = breedInfo.parentB;
  const pAUrl = `https://steemit.com/@${pA.author}/${pA.permlink}`;
  const pBUrl = `https://steemit.com/@${pB.author}/${pB.permlink}`;

  const creaturePageUrl = `${APP_URL}/#/@${username}/${permlink}`;

  const mutLine = breedInfo.speciated
    ? "⚡ **Speciation** — new genus emerged!"
    : breedInfo.mutated
      ? "🧬 **Mutation** occurred during breeding"
      : "✔ Clean inheritance";

  const body =
    `## 🧬 ${creatureName}\n\n` +
    `**Sex:** ${sexLabel}  \n` +
    `**Age:** 0 days (newborn)  \n` +
    `**Genus:** ${genusDisplay}  \n` +
    `**Lifespan:** ${genome.LIF} days  \n` +
    `**Fertile:** Day ${genome.FRT_START}–${genome.FRT_END}  \n` +
    `**Mutation tendency:** ${genome.MUT}  \n\n` +
    `${mutLine}  \n\n` +
    `**Parents:**  \n` +
    `- Parent A: ${pAUrl}  \n` +
    `- Parent B: ${pBUrl}  \n\n` +
    `\`\`\`\n${unicodeArt}\n\`\`\`\n\n` +
    `\`\`\`genome\n${JSON.stringify(genome, null, 2)}\n\`\`\`\n\n` +
    `---\n🔗 [View on SteemBiota](${creaturePageUrl})\n\n` +
    `*Bred via [SteemBiota — Immutable Evolution](${APP_URL})*`;

  const jsonMetadata = {
    app: "steembiota/1.0",
    steembiota: {
      version: "1.0",
      genome,
      name: creatureName,
      age: 0,
      lifecycleStage: "Baby",
      type: "offspring",
      parentA: pA,
      parentB: pB,
      mutated:   breedInfo.mutated,
      speciated: breedInfo.speciated
    }
  };

  const nameParts = creatureName.split(" ");
  const lastName  = (nameParts[0] || "").toLowerCase();
  const firstName = (nameParts[1] || "").toLowerCase();
  const genusTag  = (genusName || lastName).toLowerCase();
  const sexTag    = genome.SX === 0 ? "male" : "female";
  const tags      = [...new Set(["steembiota", "gaming", "evolution", "breeding", genusTag, firstName, lastName, sexTag].filter(Boolean))];

  jsonMetadata.tags = tags;

  keychainPost(
    username, title, body,
    "steembiota", "",
    jsonMetadata, permlink,
    tags,
    (response) => callback({ ...response, permlink })
  );
}

// ---- SteemBiota — publish an accessory to the blockchain ----
//
// template    : "hat" | "crown" | "necklace" | "shirt" | "wings"
// genome      : AccessoryGenome object
// accessoryName : display name
// unicodeArt  : string from buildAccessoryUnicodeArt()
// title       : post title (user-editable)
// callback    : (response) => { response.success, response.message, response.permlink }
function publishAccessory(username, template, genome, accessoryName, unicodeArt, title, callback) {
  const permlink = buildPermlink(title);
  const accessoryPageUrl = `${APP_URL}/#/acc/@${username}/${permlink}`;
  const templateLabel = template.charAt(0).toUpperCase() + template.slice(1);

  const body =
    `## ✨ ${accessoryName}\n\n` +
    `**Type:** ${templateLabel}  \n` +
    `**Hue:** ${genome.CLR}°  \n` +
    `**Saturation:** ${genome.SAT}  \n` +
    `**Lightness:** ${genome.LIT}  \n` +
    `**Size:** ${genome.SZ}%  \n` +
    `**Shininess:** ${genome.SHN}  \n\n` +
    `### Unicode Render\n\n` +
    `\`\`\`\n${unicodeArt}\n\`\`\`\n\n` +
    `### Accessory Data\n\n` +
    `\`\`\`accessory\n${JSON.stringify(genome, null, 2)}\n\`\`\`\n\n` +
    `---\n🔗 [View on SteemBiota](${accessoryPageUrl})\n\n` +
    `*Published via [SteemBiota — Immutable Evolution](${APP_URL})*`;

  const jsonMetadata = {
    app: "steembiota/1.0",
    steembiota: {
      version: "1.0",
      type: "accessory",
      accessory: {
        template,
        name: accessoryName,
        genome,
      }
    }
  };

  const tags = [...new Set([
    "steembiota", "gaming", "accessories", template,
    accessoryName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 24)
  ].filter(Boolean))];

  jsonMetadata.tags = tags;

  keychainPost(
    username, title, body,
    "steembiota", "",
    jsonMetadata, permlink,
    tags,
    (response) => callback({ ...response, permlink })
  );
}


//
// Called once per parent after a successful offspring publish.
// parentAuthor    : string — author of the parent post
// parentPermlink  : string — permlink of the parent post
// childAuthor     : string — the user who published the offspring
// childPermlink   : string — permlink of the newly published offspring post
// childName       : string — display name of the offspring
// childGenome     : object — offspring genome
// unicodeArt      : string — current unicode art of the offspring (newborn, age 0)
// breedInfo       : { mutated, speciated }
// callback        : (response) => { response.success, response.message }
function publishBirthReply(parentAuthor, parentPermlink, childAuthor, childPermlink, childName, childGenome, unicodeArt, breedInfo, callback) {
  const replyPermlink = buildPermlink("steembiota-birth-" + childName.toLowerCase());
  const sexLabel      = childGenome.SX === 0 ? "♂ Male" : "♀ Female";
  const childUrl      = `${APP_URL}/#/@${childAuthor}/${childPermlink}`;

  const mutLine = breedInfo.speciated
    ? "⚡ **Speciation** — a new genus emerged!"
    : breedInfo.mutated
      ? "🧬 **Mutation** occurred during breeding"
      : "✔ Clean inheritance";

  const body =
    `🍼 **New Offspring Born!**\n\n` +
    `**${childName}** has been born.\n\n` +
    `**Sex:** ${sexLabel}  \n` +
    `**Genus ID:** ${childGenome.GEN}  \n` +
    `**Lifespan:** ${childGenome.LIF} days  \n` +
    `${mutLine}  \n\n` +
    `\`\`\`\n${unicodeArt}\n\`\`\`\n\n` +
    `🔗 [View ${childName} on SteemBiota](${childUrl})\n\n` +
    `*Recorded via [SteemBiota — Immutable Evolution](${APP_URL})*`;

  const jsonMetadata = {
    app: "steembiota/1.0",
    tags: ["steembiota"],
    steembiota: {
      version: "1.0",
      type: "birth",
      child: { author: childAuthor, permlink: childPermlink },
      ts: new Date().toISOString()
    }
  };

  keychainPost(
    childAuthor, "", body,
    parentPermlink, parentAuthor,
    jsonMetadata, replyPermlink,
    ["steembiota"],
    callback
  );
}


//
// creatureAuthor  : string — author of the creature post
// creaturePermlink: string — permlink of the creature post
// creatureName    : string — display name for the reply body
// foodType        : "nectar" | "fruit" | "crystal"
// unicodeArt      : string — current unicode art snapshot (from buildUnicodeArt)
// callback        : (response) => { response.success, response.message }
function publishFeed(username, creatureAuthor, creaturePermlink, creatureName, foodType, unicodeArt, callback) {
  const permlink = buildPermlink("steembiota-feed-" + creatureName.toLowerCase());

  const foodEmoji = { nectar: "🍯", fruit: "🍎", crystal: "💎" }[foodType] || "🍃";
  const foodLabel = { nectar: "Nectar", fruit: "Fruit", crystal: "Crystal" }[foodType] || foodType;

  const creaturePageUrl = `${APP_URL}/#/@${creatureAuthor}/${creaturePermlink}`;

  const artBlock = unicodeArt
    ? `\`\`\`\n${unicodeArt}\n\`\`\`\n\n`
    : "";

  const body =
    `${foodEmoji} **Feeding Event** — ${foodLabel}\n\n` +
    `@${username} fed **${creatureName}** with ${foodLabel}.\n\n` +
    artBlock +
    `\`\`\`\nSTEEMBIOTA_FEED\ncreature: @${creatureAuthor}/${creaturePermlink}\nfood: ${foodType}\nfeeder: ${username}\n\`\`\`\n\n` +
    `🔗 [View ${creatureName} on SteemBiota](${creaturePageUrl})\n\n` +
    `*Recorded via [SteemBiota — Immutable Evolution](${APP_URL})*`;

  const jsonMetadata = {
    app: "steembiota/1.0",
    tags: ["steembiota"],
    steembiota: {
      version: "1.0",
      type: "feed",
      creature: { author: creatureAuthor, permlink: creaturePermlink },
      feeder: username,
      food: foodType,
      ts: new Date().toISOString()
    }
  };

  keychainPost(
    username, "", body,
    creaturePermlink, creatureAuthor,
    jsonMetadata, permlink,
    ["steembiota"],
    callback
  );
}

// ---- SteemBiota — parse feeding events from a flat reply list ----
//
// replies        : array from fetchAllReplies()
// creatureAuthor : string — owner of the creature post
//
// Returns: { total, ownerFeeds, communityFeeds, byFeeder }
// — total      : number of valid (deduplicated) feed events (capped at 20)
// — ownerFeeds : count by the creature owner
// — communityFeeds : count by others
// — byFeeder   : Map<username, count> (used for per-day dedup and display)
//
// Anti-spam rules enforced here (read-side):
//   1. Only replies whose json_metadata.steembiota.type === "feed" are counted
//   2. Each (feeder, UTC-day) pair is counted at most once
//   3. Total cap: 20 feeds maximum
function parseFeedEvents(replies, creatureAuthor) {
  // Track (feeder + UTC-day) pairs already counted
  const seen      = new Set();
  const byFeeder  = {};
  let total       = 0;
  let ownerFeeds  = 0;
  let communityFeeds = 0;

  // Sort ascending by created so earlier feeds take priority under the cap
  const sorted = [...replies].sort((a, b) =>
    new Date(a.created) - new Date(b.created)
  );

  for (const reply of sorted) {
    if (total >= 20) break;

    let meta;
    try {
      meta = JSON.parse(reply.json_metadata || "{}");
    } catch { continue; }

    if (!meta.steembiota || meta.steembiota.type !== "feed") continue;

    const feeder  = reply.author;
    const created = reply.created;
    // UTC day string used as dedup key — e.g. "2025-07-04"
    const utcDay  = (typeof created === "string"
      ? new Date(created.endsWith("Z") ? created : created + "Z")
      : new Date(created)
    ).toISOString().slice(0, 10);

    const key = `${feeder}::${utcDay}`;
    if (seen.has(key)) continue;
    seen.add(key);

    byFeeder[feeder] = (byFeeder[feeder] || 0) + 1;
    total++;
    if (feeder === creatureAuthor) ownerFeeds++;
    else communityFeeds++;
  }

  return { total, ownerFeeds, communityFeeds, byFeeder };
}

// ============================================================
// ACTIVITY SYSTEM — Play & Walk
//
// Activities are reply posts (like feeds) with type "play" or "walk".
// Anti-spam: 1 activity of each type per (user, UTC-day) per creature.
// Cap: 15 play events, 15 walk events per creature lifetime.
//
// Effects (computed client-side, never alter genome):
//   Play  → Mood boost → wider effective fertility window
//   Walk  → Vitality boost → extended effective lifespan (stacks with feed bonus)
//
// Owner activities count 2×, community count 1×.
// ============================================================

// Parse play and walk events from a flat reply list.
// Returns { playTotal, playOwner, playCommunity,
//           walkTotal, walkOwner, walkCommunity }
function parseActivityEvents(replies, creatureAuthor) {
  const seenPlay = new Set();
  const seenWalk = new Set();
  let playTotal = 0, playOwner = 0, playCommunity = 0;
  let walkTotal = 0, walkOwner = 0, walkCommunity = 0;

  const sorted = [...replies].sort((a, b) => new Date(a.created) - new Date(b.created));

  for (const reply of sorted) {
    let meta;
    try { meta = JSON.parse(reply.json_metadata || "{}"); } catch { continue; }
    if (!meta.steembiota) continue;

    const type    = meta.steembiota.type;
    if (type !== "play" && type !== "walk") continue;

    const actor  = reply.author;
    const utcDay = (reply.created.endsWith("Z") ? new Date(reply.created) : new Date(reply.created + "Z"))
                     .toISOString().slice(0, 10);
    const key    = `${actor}::${utcDay}`;

    if (type === "play") {
      if (playTotal >= 15 || seenPlay.has(key)) continue;
      seenPlay.add(key);
      playTotal++;
      if (actor === creatureAuthor) playOwner++;
      else playCommunity++;
    } else {
      if (walkTotal >= 15 || seenWalk.has(key)) continue;
      seenWalk.add(key);
      walkTotal++;
      if (actor === creatureAuthor) walkOwner++;
      else walkCommunity++;
    }
  }

  return { playTotal, playOwner, playCommunity, walkTotal, walkOwner, walkCommunity };
}

// Compute activity state from raw replies — returns bonus values and labels.
// Pass loggedInUser to compute alreadyPlayedToday / alreadyWalkedToday.
function computeActivityState(replies, creatureAuthor, loggedInUser) {
  const ev = parseActivityEvents(replies, creatureAuthor);

  // Weighted scores
  const OWNER_W = 2, COM_W = 1;
  const playScore = ev.playOwner * OWNER_W + ev.playCommunity * COM_W;
  const walkScore = ev.walkOwner * OWNER_W + ev.walkCommunity * COM_W;

  // Mood (play) → fertility window extension in days, max +20% of base FRT window
  const moodPct = Math.min(playScore / (15 * OWNER_W), 1.0);
  const fertilityExtension = Math.round(moodPct * 10);  // up to +10 days on each end

  // Vitality (walk) → lifespan extension, up to +15% of LIF (computed at render time)
  const vitalityPct = Math.min(walkScore / (15 * OWNER_W), 1.0);
  const vitalityLifespanBonus = Math.round(vitalityPct * 10); // raw days; caller scales by LIF

  // Labels
  let moodLabel = null, vitalityLabel = null;
  if      (moodPct >= 0.80) moodLabel    = "Ecstatic";
  else if (moodPct >= 0.55) moodLabel    = "Playful";
  else if (moodPct >= 0.30) moodLabel    = "Cheerful";
  else if (moodPct >  0.00) moodLabel    = "Content";

  if      (vitalityPct >= 0.80) vitalityLabel = "Vigorous";
  else if (vitalityPct >= 0.55) vitalityLabel = "Active";
  else if (vitalityPct >= 0.30) vitalityLabel = "Lively";
  else if (vitalityPct >  0.00) vitalityLabel = "Stirring";

  // Per-user today check
  const todayUTC = new Date().toISOString().slice(0, 10);
  let alreadyPlayedToday = false, alreadyWalkedToday = false;
  if (loggedInUser) {
    const sorted = [...(replies || [])];
    for (const reply of sorted) {
      if (reply.author !== loggedInUser) continue;
      let meta; try { meta = JSON.parse(reply.json_metadata || "{}"); } catch { continue; }
      if (!meta.steembiota) continue;
      const d = (reply.created.endsWith("Z") ? reply.created : reply.created + "Z");
      if (new Date(d).toISOString().slice(0, 10) !== todayUTC) continue;
      if (meta.steembiota.type === "play") alreadyPlayedToday = true;
      if (meta.steembiota.type === "walk") alreadyWalkedToday = true;
    }
  }

  return {
    ...ev,
    moodPct, vitalityPct,
    moodLabel, vitalityLabel,
    fertilityExtension,
    vitalityLifespanBonus,
    alreadyPlayedToday,
    alreadyWalkedToday,
  };
}

// ---- Publish a play event reply to the creature's post ----
function publishPlay(username, creatureAuthor, creaturePermlink, creatureName, unicodeArt, callback) {
  const permlink = buildPermlink("steembiota-play-" + creatureName.toLowerCase());
  const creaturePageUrl = `${APP_URL}/#/@${creatureAuthor}/${creaturePermlink}`;
  const artBlock = unicodeArt ? `\`\`\`\n${unicodeArt}\n\`\`\`\n\n` : "";

  const body =
    `🎮 **Play Session** — Activity Event\n\n` +
    `@${username} played with **${creatureName}**!\n\n` +
    artBlock +
    `\`\`\`\nSTEEMBIOTA_PLAY\ncreature: @${creatureAuthor}/${creaturePermlink}\nactor: ${username}\n\`\`\`\n\n` +
    `🔗 [View ${creatureName} on SteemBiota](${creaturePageUrl})\n\n` +
    `*Recorded via [SteemBiota — Immutable Evolution](${APP_URL})*`;

  const jsonMetadata = {
    app: "steembiota/1.0",
    tags: ["steembiota"],
    steembiota: {
      version: "1.0",
      type: "play",
      creature: { author: creatureAuthor, permlink: creaturePermlink },
      actor: username,
      ts: new Date().toISOString()
    }
  };

  keychainPost(username, "", body, creaturePermlink, creatureAuthor,
    jsonMetadata, permlink, ["steembiota"], callback);
}

// ---- Publish a walk event reply to the creature's post ----
function publishWalk(username, creatureAuthor, creaturePermlink, creatureName, unicodeArt, callback) {
  const permlink = buildPermlink("steembiota-walk-" + creatureName.toLowerCase());
  const creaturePageUrl = `${APP_URL}/#/@${creatureAuthor}/${creaturePermlink}`;
  const artBlock = unicodeArt ? `\`\`\`\n${unicodeArt}\n\`\`\`\n\n` : "";

  const body =
    `🦮 **Walk Session** — Activity Event\n\n` +
    `@${username} took **${creatureName}** for a walk!\n\n` +
    artBlock +
    `\`\`\`\nSTEEMBIOTA_WALK\ncreature: @${creatureAuthor}/${creaturePermlink}\nactor: ${username}\n\`\`\`\n\n` +
    `🔗 [View ${creatureName} on SteemBiota](${creaturePageUrl})\n\n` +
    `*Recorded via [SteemBiota — Immutable Evolution](${APP_URL})*`;

  const jsonMetadata = {
    app: "steembiota/1.0",
    tags: ["steembiota"],
    steembiota: {
      version: "1.0",
      type: "walk",
      creature: { author: creatureAuthor, permlink: creaturePermlink },
      actor: username,
      ts: new Date().toISOString()
    }
  };

  keychainPost(username, "", body, creaturePermlink, creatureAuthor,
    jsonMetadata, permlink, ["steembiota"], callback);
}


// ============================================================
// BREEDING PERMIT SYSTEM
//
// Philosophy: opt-in permitting — creatures are CLOSED to external
// breeding by default. The owner must explicitly grant a named permit
// to allow another user to use their creature as a parent.
//
// Permit reply shape:
//   type       : "breed_permit"
//   grantee    : string — Steem username being permitted
//   expires_days : number — days from permit publish date (0 = no expiry)
//
// Revocation reply shape:
//   type       : "breed_revoke"
//   grantee    : string — Steem username being revoked
//
// Rules (enforced in parseBreedPermits):
//   1. Only replies authored by the creature owner are counted.
//   2. For each grantee, the LATEST action (permit or revoke) wins.
//   3. An expired permit is treated identically to a revocation.
//   4. The creature owner always has implicit permission on their own creature.
// ============================================================

// Parse breed permits from a flat reply list.
// creatureAuthor : string — the owner of the creature post
//
// Returns:
//   { grantees: Set<username> }  — usernames currently holding a valid permit
function parseBreedPermits(replies, creatureAuthor) {
  // For each grantee, track the most recent action and its timestamp.
  // Map<grantee, { type: "breed_permit"|"breed_revoke", ts: Date, expiry: Date|null }>
  const latestAction = new Map();

  const sorted = [...replies].sort((a, b) =>
    new Date(a.created) - new Date(b.created)
  );

  for (const reply of sorted) {
    // Only owner replies count
    if (reply.author !== creatureAuthor) continue;

    let meta;
    try { meta = JSON.parse(reply.json_metadata || "{}"); } catch { continue; }
    if (!meta.steembiota) continue;

    const type    = meta.steembiota.type;
    const grantee = meta.steembiota.grantee;
    if ((type !== "breed_permit" && type !== "breed_revoke") || !grantee) continue;

    const ts = new Date(
      reply.created.endsWith("Z") ? reply.created : reply.created + "Z"
    );

    let expiry = null;
    if (type === "breed_permit") {
      const days = Number(meta.steembiota.expires_days);
      if (!isNaN(days) && days > 0) {
        expiry = new Date(ts.getTime() + days * 86400000);
      }
    }

    // Last action wins — sorted ascending so each loop overwrites earlier entries
    latestAction.set(grantee, { type, ts, expiry });
  }

  const now = new Date();
  const grantees = new Set();

  for (const [grantee, action] of latestAction) {
    if (action.type !== "breed_permit") continue;       // revoked
    if (action.expiry && now > action.expiry) continue; // expired
    grantees.add(grantee);
  }

  return { grantees };
}

// Check if a user is allowed to breed a specific creature.
// creatureAuthor : string — owner of the creature
// breedingUser   : string — the user attempting to breed
// permits        : result of parseBreedPermits()
//
// Returns true if allowed, false if not.
function isBreedingPermitted(creatureAuthor, breedingUser, permits) {
  if (!breedingUser) return false;
  if (breedingUser === creatureAuthor) return true; // owner always allowed
  return permits.grantees.has(breedingUser);
}

// Publish a breed permit reply to the creature's post.
// grantee      : string — Steem username to permit
// expiresDays  : number — days until expiry (0 = no expiry)
function publishBreedPermit(username, creatureAuthor, creaturePermlink, creatureName, grantee, expiresDays, callback) {
  const permlink = buildPermlink("steembiota-permit-" + grantee.toLowerCase());
  const creaturePageUrl = `${APP_URL}/#/@${creatureAuthor}/${creaturePermlink}`;
  const expiryLine = (expiresDays > 0)
    ? `Expires in **${expiresDays} day${expiresDays === 1 ? "" : "s"}** from now.`
    : "No expiry — valid until revoked.";

  const body =
    `🔑 **Breed Permit Granted**\n\n` +
    `@${username} has granted @${grantee} permission to use **${creatureName}** as a breeding parent.\n\n` +
    `${expiryLine}\n\n` +
    `\`\`\`\nSTEEMBIOTA_BREED_PERMIT\ncreature: @${creatureAuthor}/${creaturePermlink}\ngrantee: ${grantee}\nexpires_days: ${expiresDays}\n\`\`\`\n\n` +
    `🔗 [View ${creatureName} on SteemBiota](${creaturePageUrl})\n\n` +
    `*Recorded via [SteemBiota — Immutable Evolution](${APP_URL})*`;

  const jsonMetadata = {
    app: "steembiota/1.0",
    tags: ["steembiota"],
    steembiota: {
      version: "1.0",
      type: "breed_permit",
      creature: { author: creatureAuthor, permlink: creaturePermlink },
      grantee,
      expires_days: expiresDays,
      ts: new Date().toISOString()
    }
  };

  keychainPost(username, "", body,
    creaturePermlink, creatureAuthor,
    jsonMetadata, permlink, ["steembiota"], callback);
}

// Publish a breed permit revocation reply to the creature's post.
function publishBreedRevoke(username, creatureAuthor, creaturePermlink, creatureName, grantee, callback) {
  const permlink = buildPermlink("steembiota-revoke-" + grantee.toLowerCase());
  const creaturePageUrl = `${APP_URL}/#/@${creatureAuthor}/${creaturePermlink}`;

  const body =
    `🚫 **Breed Permit Revoked**\n\n` +
    `@${username} has revoked @${grantee}'s breeding permission for **${creatureName}**.\n\n` +
    `\`\`\`\nSTEEMBIOTA_BREED_REVOKE\ncreature: @${creatureAuthor}/${creaturePermlink}\ngrantee: ${grantee}\n\`\`\`\n\n` +
    `🔗 [View ${creatureName} on SteemBiota](${creaturePageUrl})\n\n` +
    `*Recorded via [SteemBiota — Immutable Evolution](${APP_URL})*`;

  const jsonMetadata = {
    app: "steembiota/1.0",
    tags: ["steembiota"],
    steembiota: {
      version: "1.0",
      type: "breed_revoke",
      creature: { author: creatureAuthor, permlink: creaturePermlink },
      grantee,
      ts: new Date().toISOString()
    }
  };

  keychainPost(username, "", body,
    creaturePermlink, creatureAuthor,
    jsonMetadata, permlink, ["steembiota"], callback);
}


// ============================================================
// OWNERSHIP TRANSFER SYSTEM — Two-sided handshake
//
// Philosophy: the original post.author is the immutable on-chain author
// forever. "Effective owner" is a derived concept tracked by SteemBiota
// through a chain of signed transfer events in the reply tree.
//
// Two-step protocol:
//   Step 1 — Current owner publishes a transfer_offer reply naming the
//             recipient. Only one pending offer may exist at a time;
//             publishing a new offer implicitly cancels the previous one.
//   Step 2 — Recipient publishes a transfer_accept reply on the SAME
//             creature post, referencing the offer permlink. Only then
//             does effective ownership transfer.
//
// Cancellation: Current owner publishes transfer_cancel at any time
//               before acceptance to withdraw the offer.
//
// Transfer reply shapes:
//   transfer_offer   : { type, to, ts }
//   transfer_accept  : { type, offer_permlink, ts }  — authored by recipient
//   transfer_cancel  : { type, ts }                  — authored by current owner
//
// Rules enforced in parseOwnershipChain():
//   1. Only the effective owner at the time of an offer may publish it.
//   2. Only the named recipient may publish transfer_accept.
//   3. transfer_cancel by the effective owner voids the pending offer.
//   4. Permits granted before a completed transfer are voided — the new
//      owner starts with a clean permit slate.
//   5. There is no expiry on offers — they stay open until accepted or
//      cancelled. (Owners can cancel at any time.)
// ============================================================

// Walk the reply list and derive the full ownership chain.
// Returns:
//   {
//     effectiveOwner : string   — current owner username
//     transferHistory: Array<{ from, to, ts }>  — completed transfers
//     pendingOffer   : { to, offerPermlink, ts } | null
//     permitsValidFrom: Date | null  — permits before this date are void
//   }
function parseOwnershipChain(replies, postAuthor) {
  // Sort ascending — earliest events first
  const sorted = [...replies].sort((a, b) =>
    new Date(a.created) - new Date(b.created)
  );

  // Build a fast lookup: permlink → reply (for accept cross-referencing)
  const byPermlink = {};
  for (const r of sorted) byPermlink[r.permlink] = r;

  let effectiveOwner   = postAuthor;
  const transferHistory = [];
  let pendingOffer      = null;   // { to, offerPermlink, offeredBy, ts }
  let permitsValidFrom  = null;   // Date of last completed transfer

  for (const reply of sorted) {
    let meta;
    try { meta = JSON.parse(reply.json_metadata || '{}'); } catch { continue; }
    if (!meta.steembiota) continue;

    const type   = meta.steembiota.type;
    const author = reply.author;
    const ts     = new Date(
      reply.created.endsWith('Z') ? reply.created : reply.created + 'Z'
    );

    if (type === 'transfer_offer') {
      // Only current effective owner may make an offer
      if (author !== effectiveOwner) continue;
      const to = meta.steembiota.to;
      if (!to || to === effectiveOwner) continue;
      // Publishing a new offer replaces any previous pending offer
      pendingOffer = { to, offerPermlink: reply.permlink, offeredBy: author, ts };

    } else if (type === 'transfer_cancel') {
      // Only current effective owner may cancel
      if (author !== effectiveOwner) continue;
      pendingOffer = null;

    } else if (type === 'transfer_accept') {
      // Must reference a pending offer, and must be authored by the named recipient
      if (!pendingOffer) continue;
      const offerPermlink = meta.steembiota.offer_permlink;
      if (offerPermlink !== pendingOffer.offerPermlink) continue;
      if (author !== pendingOffer.to) continue;

      // Transfer confirmed
      transferHistory.push({
        from: effectiveOwner,
        to:   author,
        ts
      });
      effectiveOwner  = author;
      pendingOffer    = null;
      permitsValidFrom = ts;   // all pre-transfer permits are now void
    }
  }

  return { effectiveOwner, transferHistory, pendingOffer, permitsValidFrom };
}

// Extend parseBreedPermits to respect the permitsValidFrom timestamp.
// Permits issued before the last ownership transfer are automatically void.
// This shadows the original parseBreedPermits with a transfer-aware version.
function parseBreedPermitsWithTransfer(replies, effectiveOwner, permitsValidFrom) {
  const latestAction = new Map();

  const sorted = [...replies].sort((a, b) =>
    new Date(a.created) - new Date(b.created)
  );

  for (const reply of sorted) {
    if (reply.author !== effectiveOwner) continue;

    let meta;
    try { meta = JSON.parse(reply.json_metadata || '{}'); } catch { continue; }
    if (!meta.steembiota) continue;

    const type    = meta.steembiota.type;
    const grantee = meta.steembiota.grantee;
    if ((type !== 'breed_permit' && type !== 'breed_revoke') || !grantee) continue;

    const ts = new Date(
      reply.created.endsWith('Z') ? reply.created : reply.created + 'Z'
    );

    // Void any permits/revokes that predate the last ownership transfer
    if (permitsValidFrom && ts < permitsValidFrom) continue;

    let expiry = null;
    if (type === 'breed_permit') {
      const days = Number(meta.steembiota.expires_days);
      if (!isNaN(days) && days > 0) {
        expiry = new Date(ts.getTime() + days * 86400000);
      }
    }

    latestAction.set(grantee, { type, ts, expiry });
  }

  const now = new Date();
  const grantees = new Set();
  for (const [grantee, action] of latestAction) {
    if (action.type !== 'breed_permit') continue;
    if (action.expiry && now > action.expiry) continue;
    grantees.add(grantee);
  }

  return { grantees };
}

// ---- Publish a transfer offer reply to the creature's post ----
// to : string — Steem username of the intended new owner
function publishTransferOffer(username, creatureAuthor, creaturePermlink, creatureName, to, callback) {
  const permlink = buildPermlink('steembiota-transfer-offer-' + to.toLowerCase());
  const creaturePageUrl = `${APP_URL}/#/@${creatureAuthor}/${creaturePermlink}`;

  const body =
    `🤝 **Ownership Transfer Offer**\n\n` +
    `@${username} is offering to transfer **${creatureName}** to @${to}.\n\n` +
    `To accept, @${to} must publish a \`transfer_accept\` reply on the creature's post ` +
    `referencing this offer permlink: \`${permlink}\`\n\n` +
    `The offer can be cancelled by @${username} at any time before acceptance.\n\n` +
    `\`\`\`\nSTEEMBIOTA_TRANSFER_OFFER\ncreature: @${creatureAuthor}/${creaturePermlink}\nto: ${to}\n\`\`\`\n\n` +
    `🔗 [View ${creatureName} on SteemBiota](${creaturePageUrl})\n\n` +
    `*Recorded via [SteemBiota — Immutable Evolution](${APP_URL})*`;

  const jsonMetadata = {
    app: 'steembiota/1.0',
    tags: ['steembiota'],
    steembiota: {
      version: '1.0',
      type: 'transfer_offer',
      creature: { author: creatureAuthor, permlink: creaturePermlink },
      to,
      ts: new Date().toISOString()
    }
  };

  keychainPost(username, '', body,
    creaturePermlink, creatureAuthor,
    jsonMetadata, permlink, ['steembiota'], callback);
}

// ---- Publish a transfer acceptance reply ----
// offerPermlink : string — permlink of the transfer_offer reply being accepted
function publishTransferAccept(username, creatureAuthor, creaturePermlink, creatureName, offerPermlink, callback) {
  const permlink = buildPermlink('steembiota-transfer-accept');
  const creaturePageUrl = `${APP_URL}/#/@${creatureAuthor}/${creaturePermlink}`;

  const body =
    `✅ **Ownership Transfer Accepted**\n\n` +
    `@${username} has accepted ownership of **${creatureName}**.\n\n` +
    `\`\`\`\nSTEEMBIOTA_TRANSFER_ACCEPT\ncreature: @${creatureAuthor}/${creaturePermlink}\noffer_permlink: ${offerPermlink}\n\`\`\`\n\n` +
    `🔗 [View ${creatureName} on SteemBiota](${creaturePageUrl})\n\n` +
    `*Recorded via [SteemBiota — Immutable Evolution](${APP_URL})*`;

  const jsonMetadata = {
    app: 'steembiota/1.0',
    tags: ['steembiota'],
    steembiota: {
      version: '1.0',
      type: 'transfer_accept',
      creature: { author: creatureAuthor, permlink: creaturePermlink },
      offer_permlink: offerPermlink,
      ts: new Date().toISOString()
    }
  };

  keychainPost(username, '', body,
    creaturePermlink, creatureAuthor,
    jsonMetadata, permlink, ['steembiota'], callback);
}

// ---- Publish a transfer cancellation reply ----
function publishTransferCancel(username, creatureAuthor, creaturePermlink, creatureName, callback) {
  const permlink = buildPermlink('steembiota-transfer-cancel');
  const creaturePageUrl = `${APP_URL}/#/@${creatureAuthor}/${creaturePermlink}`;

  const body =
    `❌ **Ownership Transfer Cancelled**\n\n` +
    `@${username} has cancelled the pending transfer offer for **${creatureName}**.\n\n` +
    `\`\`\`\nSTEEMBIOTA_TRANSFER_CANCEL\ncreature: @${creatureAuthor}/${creaturePermlink}\n\`\`\`\n\n` +
    `🔗 [View ${creatureName} on SteemBiota](${creaturePageUrl})\n\n` +
    `*Recorded via [SteemBiota — Immutable Evolution](${APP_URL})*`;

  const jsonMetadata = {
    app: 'steembiota/1.0',
    tags: ['steembiota'],
    steembiota: {
      version: '1.0',
      type: 'transfer_cancel',
      creature: { author: creatureAuthor, permlink: creaturePermlink },
      ts: new Date().toISOString()
    }
  };

  keychainPost(username, '', body,
    creaturePermlink, creatureAuthor,
    jsonMetadata, permlink, ['steembiota'], callback);
}


//
// Prevents inbreeding and farming by forbidding breeding between
// creatures that are related by blood. Forbidden relationships:
//
//   • Ancestors (parents, grandparents, … all the way up)
//   • Descendants (children, grandchildren, … all the way down)
//   • Siblings (full or half — any creature sharing ≥1 parent)
//   • Parents' siblings (aunts/uncles, full or half)
//   • Siblings' descendants (nieces/nephews and their progeny)
//
// Strategy:
//   1. Walk ancestry of both creatures upward via json_metadata
//      parentA/parentB fields (BFS, bounded by MAX_ANCESTOR_DEPTH).
//   2. Collect every author seen during that walk.
//   3. Fetch all SteemBiota posts by those authors to build a local
//      corpus — this is where relatives are most likely to appear.
//   4. Within the corpus, identify all relatives of each creature
//      using the five rules above.
//   5. Check that neither creature appears in the other's forbidden set.
// ============================================================

const MAX_ANCESTOR_DEPTH = 12;   // max generations to walk upward
const POSTS_PER_AUTHOR   = 100;  // how many recent posts to fetch per author

// Parse json_metadata from a raw Steem post object.
// Returns the steembiota sub-object, or null if not a SteemBiota post.
function steembiotaMeta(post) {
  try {
    const m = JSON.parse(post.json_metadata || "{}");
    return (m && m.steembiota) ? m.steembiota : null;
  } catch { return null; }
}

// Canonical key for a creature post.
function nodeKey(author, permlink) { return `${author}/${permlink}`; }

// Detect a tombstoned (deleted) Steem post.
// steem.api.getContent returns a post object with author === "" when the
// post has been removed via delete_comment. The original broadcast is
// still recorded in the immutable block history, but the API no longer
// serves its content.
function isPhantomPost(post) {
  return post && post.author === "" && post.permlink !== "";
}

// Fetch a post and return its steembiota meta + key, or null.
// Returns { key, author, permlink, meta, phantom: false } for live posts.
// Returns { key, author, permlink, meta: null, phantom: true } for tombstoned posts.
// Returns null if the post cannot be found at all or is not a SteemBiota post.
async function fetchSteembiotaPost(author, permlink) {
  try {
    const post = await fetchPost(author, permlink);
    if (!post) return null;

    // Tombstoned — author field is empty string after delete_comment
    if (isPhantomPost(post)) {
      return { key: nodeKey(author, permlink), author, permlink, meta: null, phantom: true };
    }

    if (!post.author) return null;
    const meta = steembiotaMeta(post);
    if (!meta) return null;
    return { key: nodeKey(author, permlink), author, permlink, meta, phantom: false };
  } catch { return null; }
}

// Walk ancestors of a creature upward via BFS.
// Returns a Map<key, {author,permlink,meta,depth}> of all ancestors found.
// If any ancestor is tombstoned (phantom), throws an Error so callers can
// refuse breeding — an incomplete ancestry tree could mask inbreeding.
async function fetchAncestors(startAuthor, startPermlink) {
  const visited = new Map();                           // key → node
  const queue   = [{ author: startAuthor, permlink: startPermlink, depth: 0 }];

  while (queue.length > 0) {
    const { author, permlink, depth } = queue.shift();
    const key = nodeKey(author, permlink);
    if (visited.has(key)) continue;

    const node = await fetchSteembiotaPost(author, permlink);
    if (!node) continue;

    // Phantom ancestor — ancestry incomplete, breeding must be refused.
    if (node.phantom) {
      throw new Error(
        `Ancestor @${author}/${permlink} is a Phantom — its post was removed from the ` +
        `visible chain. Ancestry cannot be fully verified; breeding is blocked to ` +
        `protect genetic integrity.`
      );
    }

    visited.set(key, { ...node, depth });

    if (depth >= MAX_ANCESTOR_DEPTH) continue;

    // Enqueue parents if this was an offspring post
    const pA = node.meta.parentA;
    const pB = node.meta.parentB;
    if (pA && pA.author && pA.permlink)
      queue.push({ author: pA.author, permlink: pA.permlink, depth: depth + 1 });
    if (pB && pB.author && pB.permlink)
      queue.push({ author: pB.author, permlink: pB.permlink, depth: depth + 1 });
  }

  return visited;
}

// Fetch all SteemBiota posts by a set of authors and return as a Map<key, node>.
async function fetchCorpusByAuthors(authorSet) {
  const corpus = new Map();
  await Promise.all([...authorSet].map(async author => {
    try {
      const posts = await fetchPostsByUser(author, POSTS_PER_AUTHOR);
      if (!Array.isArray(posts)) return;
      for (const post of posts) {
        const meta = steembiotaMeta(post);
        if (!meta) continue;
        const key = nodeKey(post.author, post.permlink);
        corpus.set(key, { key, author: post.author, permlink: post.permlink, meta });
      }
    } catch { /* skip author on error */ }
  }));
  return corpus;
}

// From a corpus Map, find all descendants of a set of keys (children, grandchildren, …).
// Returns a Set<key> of all descendants.
function findDescendants(seedKeys, corpus) {
  const descendants = new Set();
  let frontier = new Set(seedKeys);

  while (frontier.size > 0) {
    const nextFrontier = new Set();
    for (const [key, node] of corpus) {
      if (descendants.has(key)) continue;
      const pA = node.meta.parentA;
      const pB = node.meta.parentB;
      const paKey = pA && pA.author ? nodeKey(pA.author, pA.permlink) : null;
      const pbKey = pB && pB.author ? nodeKey(pB.author, pB.permlink) : null;
      if ((paKey && frontier.has(paKey)) || (pbKey && frontier.has(pbKey))) {
        descendants.add(key);
        nextFrontier.add(key);
      }
    }
    frontier = nextFrontier;
  }
  return descendants;
}

// Find all siblings of a set of keys (share ≥1 parent with any key in seedKeys).
// parentMap: Map<key, [parentKeyA, parentKeyB]> built from the corpus.
// Returns a Set<key> of siblings (excluding the seeds themselves).
function findSiblings(seedKeys, corpus) {
  // Collect parent keys for all seeds
  const seedParents = new Set();
  for (const seedKey of seedKeys) {
    const node = corpus.get(seedKey);
    if (!node) continue;
    const pA = node.meta.parentA;
    const pB = node.meta.parentB;
    if (pA && pA.author) seedParents.add(nodeKey(pA.author, pA.permlink));
    if (pB && pB.author) seedParents.add(nodeKey(pB.author, pB.permlink));
  }
  if (seedParents.size === 0) return new Set();

  // Any corpus node that shares a parent with a seed is a sibling
  const siblings = new Set();
  for (const [key, node] of corpus) {
    if (seedKeys.has(key)) continue;
    const pA = node.meta.parentA;
    const pB = node.meta.parentB;
    const paKey = pA && pA.author ? nodeKey(pA.author, pA.permlink) : null;
    const pbKey = pB && pB.author ? nodeKey(pB.author, pB.permlink) : null;
    if ((paKey && seedParents.has(paKey)) || (pbKey && seedParents.has(pbKey))) {
      siblings.add(key);
    }
  }
  return siblings;
}

// Build the complete forbidden set for one creature identified by key.
// ancestorMap : Map returned by fetchAncestors (includes the creature itself at depth 0)
// corpus      : Map of all fetched SteemBiota posts by related authors
// Returns Set<key> of all forbidden counterparts.
function buildForbiddenSet(selfKey, ancestorMap, corpus) {
  const forbidden = new Set();

  // 1. Self (never breed with yourself — also caught by URL equality check)
  forbidden.add(selfKey);

  // 2. All ancestors
  for (const key of ancestorMap.keys()) forbidden.add(key);

  // 3. All descendants of self
  const selfDescendants = findDescendants(new Set([selfKey]), corpus);
  for (const k of selfDescendants) forbidden.add(k);

  // 4. Siblings of self (share a parent with self)
  const selfSiblings = findSiblings(new Set([selfKey]), corpus);
  for (const k of selfSiblings) forbidden.add(k);

  // 5. For each ancestor: its siblings (aunts/uncles) + those siblings' descendants
  for (const ancKey of ancestorMap.keys()) {
    // Siblings of this ancestor (parent's other children)
    const ancSiblings = findSiblings(new Set([ancKey]), corpus);
    for (const k of ancSiblings) forbidden.add(k);
    // Descendants of those siblings (cousins, second cousins, …)
    const sibDescendants = findDescendants(ancSiblings, corpus);
    for (const k of sibDescendants) forbidden.add(k);
  }

  // 6. Descendants of self's siblings
  const sibDescendants = findDescendants(selfSiblings, corpus);
  for (const k of sibDescendants) forbidden.add(k);

  return forbidden;
}

// ---- Main entry point ----
//
// resA, resB : objects from loadGenomeFromPost — { genome, author, permlink }
//
// Returns null if compatible, or throws an Error with a human-readable
// explanation if the pair is forbidden.
async function checkBreedingCompatibility(resA, resB) {
  const keyA = nodeKey(resA.author, resA.permlink);
  const keyB = nodeKey(resB.author, resB.permlink);

  // Walk ancestors for both creatures in parallel
  const [ancestorsA, ancestorsB] = await Promise.all([
    fetchAncestors(resA.author, resA.permlink),
    fetchAncestors(resB.author, resB.permlink)
  ]);

  // Remove self from ancestor maps (fetchAncestors includes depth-0 node)
  ancestorsA.delete(keyA);
  ancestorsB.delete(keyB);

  // Collect all authors from both ancestry trees to build a rich corpus
  const authorSet = new Set([resA.author, resB.author]);
  for (const node of ancestorsA.values()) authorSet.add(node.author);
  for (const node of ancestorsB.values()) authorSet.add(node.author);

  // Fetch all SteemBiota posts by those authors + add known ancestor nodes to corpus
  const corpus = await fetchCorpusByAuthors(authorSet);

  // Seed corpus with ancestor nodes in case they predate the blog fetch window
  for (const [k, n] of ancestorsA) corpus.set(k, n);
  for (const [k, n] of ancestorsB) corpus.set(k, n);
  // Also add the two creatures themselves
  const nodeA = await fetchSteembiotaPost(resA.author, resA.permlink);
  const nodeB = await fetchSteembiotaPost(resB.author, resB.permlink);
  if (nodeA) corpus.set(keyA, nodeA);
  if (nodeB) corpus.set(keyB, nodeB);

  // Build forbidden sets for each creature
  const forbiddenA = buildForbiddenSet(keyA, ancestorsA, corpus);
  const forbiddenB = buildForbiddenSet(keyB, ancestorsB, corpus);

  // Helper: describe the relationship for the error message
  function describeRelationship(subjectKey, otherKey, ancestorMap, corpus) {
    if (ancestorMap.has(otherKey)) {
      const depth = ancestorMap.get(otherKey).depth;
      if (depth === 1) return "a parent";
      if (depth === 2) return "a grandparent";
      if (depth === 3) return "a great-grandparent";
      return `an ancestor (${depth} generations up)`;
    }
    // Check if other is a descendant of subject
    const desc = findDescendants(new Set([subjectKey]), corpus);
    if (desc.has(otherKey)) return "a descendant";

    // Check if sibling
    const sibs = findSiblings(new Set([subjectKey]), corpus);
    if (sibs.has(otherKey)) return "a sibling";

    // Check if aunt/uncle (sibling of an ancestor)
    for (const [ancKey, ancNode] of ancestorMap) {
      const ancSibs = findSiblings(new Set([ancKey]), corpus);
      if (ancSibs.has(otherKey)) {
        const depth = ancNode.depth;
        if (depth === 1) return "an aunt or uncle";
        return `a relative (sibling of an ancestor ${depth} generations up)`;
      }
      // Check if niece/nephew descendant (descendant of a sibling)
      const selfSibs = findSiblings(new Set([subjectKey]), corpus);
      const nibDescendants = findDescendants(selfSibs, corpus);
      if (nibDescendants.has(otherKey)) return "a niece, nephew, or their descendant";
    }
    return "a close relative";
  }

  // Check compatibility
  if (forbiddenA.has(keyB)) {
    const rel = describeRelationship(keyA, keyB, ancestorsA, corpus);
    throw new Error(
      `Breeding forbidden: ${resB.author}/${resB.permlink} is ${rel} of ${resA.author}/${resA.permlink}. ` +
      `SteemBiota prevents inbreeding to encourage genetic diversity.`
    );
  }
  if (forbiddenB.has(keyA)) {
    const rel = describeRelationship(keyB, keyA, ancestorsB, corpus);
    throw new Error(
      `Breeding forbidden: ${resA.author}/${resA.permlink} is ${rel} of ${resB.author}/${resB.permlink}. ` +
      `SteemBiota prevents inbreeding to encourage genetic diversity.`
    );
  }

  return null; // compatible
}

// ---- Utility ----

// Build a Steem permlink from an arbitrary title string.
// Lowercases, replaces whitespace/punctuation with hyphens,
// strips non-ASCII, truncates the slug at 200 chars, then
// appends a millisecond timestamp so it is always unique.
function buildPermlink(title) {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/, "")
    .slice(0, 200);                       // leave room for -<13-digit timestamp>
  return `${slug}-${Date.now()}`;
}

// Format a Date into a natural-language birth phrase.
// e.g. "born at noon on Tuesday, March 4, 2025"
//      "born at 7 in the morning on Monday, January 3, 2026"
function formatBirthTime(date) {
  if (!(date instanceof Date) || isNaN(date)) date = new Date();

  const DAYS   = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const MONTHS = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];

  const hour    = date.getUTCHours();
  const weekday = DAYS[date.getUTCDay()];
  const month   = MONTHS[date.getUTCMonth()];
  const day     = date.getUTCDate();
  const year    = date.getUTCFullYear();

  // Convert 0–23 UTC hour to a natural English time-of-day phrase
  const HOUR_PHRASES = [
    "midnight",             // 0
    "1 in the morning",     // 1
    "2 in the morning",     // 2
    "3 in the morning",     // 3
    "4 in the morning",     // 4
    "5 in the morning",     // 5
    "6 in the morning",     // 6
    "7 in the morning",     // 7
    "8 in the morning",     // 8
    "9 in the morning",     // 9
    "10 in the morning",    // 10
    "11 in the morning",    // 11
    "noon",                 // 12
    "1 in the afternoon",   // 13
    "2 in the afternoon",   // 14
    "3 in the afternoon",   // 15
    "4 in the afternoon",   // 16
    "5 in the afternoon",   // 17
    "6 in the evening",     // 18
    "7 in the evening",     // 19
    "8 in the evening",     // 20
    "9 at night",           // 21
    "10 at night",          // 22
    "11 at night",          // 23
  ];

  const timePhrase = HOUR_PHRASES[hour];
  return `born at ${timePhrase} UTC on ${weekday}, ${month} ${day}, ${year}`;
}

// Build the default post title for a creature.
// birthDate : Date object (defaults to now)
function buildDefaultTitle(creatureName, birthDate) {
  const born = formatBirthTime(birthDate instanceof Date ? birthDate : new Date());
  return `${creatureName} — ${born}`;
}

function steemDate(ts) {
  if (!ts) return new Date(NaN);
  if (typeof ts === "string" && !ts.endsWith("Z")) ts += "Z";
  return new Date(ts);
}

// Fetch a user's comment/reply history (feed replies, birth replies, etc.)
function fetchUserComments(username, limit = 100) {
  return callWithFallbackAsync(
    steem.api.getDiscussionsByComments,
    [{ start_author: username, limit }]
  );
}

// ---- Standard Steem social interactions ----

// Upvote a post at full weight (100%).
// weight : integer 0–10000 (10000 = 100%). Default is 10000.
function publishVote(username, author, permlink, weight, callback) {
  if (!window.steem_keychain) return callback({ success: false, message: "Keychain not installed." });
  steem_keychain.requestVote(username, permlink, author, weight, (response) => {
    callback({ success: response.success, message: response.message || response.error || "" });
  });
}

// Resteem (reblog) a post via custom_json broadcast.
// Uses the Steem "follow" plugin custom_json format for reblogs.
function publishResteem(username, author, permlink, callback) {
  if (!window.steem_keychain) return callback({ success: false, message: "Keychain not installed." });
  const json = JSON.stringify([
    "reblog",
    { account: username, author, permlink }
  ]);
  steem_keychain.requestCustomJson(
    username,
    "follow",
    "Posting",
    json,
    "Resteem on SteemBiota",
    (response) => {
      callback({ success: response.success, message: response.message || response.error || "" });
    }
  );
}

// Returns an array of vote objects for a post, sorted by vote weight descending.
// Each object: { voter, percent, weight, rshares, reputation, time }
function fetchVotes(author, permlink) {
  return callWithFallbackAsync(
    steem.api.getActiveVotes,
    [author, permlink]
  ).then(votes => {
    if (!Array.isArray(votes)) return [];
    return [...votes].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  });
}

// Returns all votes cast by a user (up to the last ~1000 as enforced by the Steem API).
// Each object: { author, permlink, weight, rshares, percent, time }
// Used to count how many distinct SteemBiota creature posts the user has upvoted.
function fetchAccountVotes(username) {
  return callWithFallbackAsync(
    steem.api.getAccountVotes,
    [username]
  ).then(votes => {
    if (!Array.isArray(votes)) return [];
    // Keep only positive votes (weight > 0); downvotes don't count.
    return votes.filter(v => (v.weight ?? v.percent ?? 1) > 0);
  }).catch(() => []);   // degrade gracefully if node doesn't support this call
}

// Returns an array of usernames who have reblogged (resteemed) a post.
function fetchRebloggers(author, permlink) {
  return callWithFallbackAsync(
    steem.api.getRebloggedBy,
    [author, permlink]
  ).then(result => {
    if (!Array.isArray(result)) return [];
    // getRebloggedBy includes the original author; strip them out
    return result.filter(u => u !== author);
  }).catch(() => []);   // getRebloggedBy may not exist on all nodes — degrade gracefully
}

// Publish a plain (non-SteemBiota) comment on a creature post.
// The comment has no steembiota metadata so it is treated as a social comment,
// not a game event, and will appear in the Comments section rather than
// being parsed by parseFeedEvents / computeActivityState.
function publishComment(username, body, parentAuthor, parentPermlink, callback) {
  const permlink = buildPermlink('re-' + parentAuthor + '-' + parentPermlink);
  const jsonMetadata = {
    app: 'steembiota/1.0',
    tags: ['steembiota']
    // Deliberately no "steembiota" game key — keeps this a social comment only
  };
  keychainPost(
    username, '', body,
    parentPermlink, parentAuthor,
    jsonMetadata, permlink, ['steembiota'],
    callback
  );
}

// ============================================================
// OWNED ACCESSORIES — mirrors fetchCreaturesOwnedBy but for
// type:"accessory" posts.  Resolves effective ownership from
// the same two-sided transfer chain used by creatures.
// ============================================================

async function fetchAccessoriesOwnedBy(username, limit = 100) {
  if (!username) return [];
  const results = [];

  // ── Own posts ──────────────────────────────────────────────
  try {
    const raw = await fetchPostsByUser(username, limit);
    await _throttledMap((Array.isArray(raw) ? raw : []).filter(p => {
      if (p.author !== username) return false;  // skip resteems
      try { const m = JSON.parse(p.json_metadata || '{}'); return m.steembiota?.type === 'accessory'; } catch { return false; }
    }), 5, async (p) => {
      let meta = {};
      try { meta = JSON.parse(p.json_metadata || '{}'); } catch { return; }
      let replies = [];
      try { replies = await fetchAllReplies(p.author, p.permlink); } catch {}
      const hasTransfer = replies.some(r => {
        try { const m = JSON.parse(r.json_metadata || '{}'); return ['transfer_offer','transfer_accept','transfer_cancel'].includes(m.steembiota?.type); } catch { return false; }
      });
      const effectiveOwner = hasTransfer ? parseOwnershipChain(replies, p.author).effectiveOwner : p.author;
      if (effectiveOwner === username) {
        const acc = meta.steembiota.accessory;
        results.push({ author: p.author, permlink: p.permlink, name: acc?.name || p.author, template: acc?.template || 'hat', genome: acc?.genome, created: p.created || '', effectiveOwner });
      }
    });
  } catch {}

  // ── Incoming transfers ─────────────────────────────────────
  try {
    const tagPosts = await fetchPostsByTag('steembiota', 100);
    await _throttledMap((Array.isArray(tagPosts) ? tagPosts : []).filter(p => {
      if (p.author === username) return false;
      try { const m = JSON.parse(p.json_metadata || '{}'); return m.steembiota?.type === 'accessory'; } catch { return false; }
    }), 5, async (p) => {
      let meta = {};
      try { meta = JSON.parse(p.json_metadata || '{}'); } catch { return; }
      let replies = [];
      try { replies = await fetchAllReplies(p.author, p.permlink); } catch { return; }
      const hasTransfer = replies.some(r => {
        try { const m = JSON.parse(r.json_metadata || '{}'); return ['transfer_offer','transfer_accept','transfer_cancel'].includes(m.steembiota?.type); } catch { return false; }
      });
      if (!hasTransfer) return;
      const chain = parseOwnershipChain(replies, p.author);
      if (chain.effectiveOwner === username) {
        const acc = meta.steembiota.accessory;
        results.push({ author: p.author, permlink: p.permlink, name: acc?.name || p.author, template: acc?.template || 'hat', genome: acc?.genome, created: p.created || '', effectiveOwner: username });
      }
    });
  } catch {}

  return results;
}

//
// Scans the reply trees of a user's own creature posts to find
// events where other users interacted with them.
// Also scans all steembiota posts for transfer_offer replies
// naming the user as recipient.
//
// Event types collected:
//   feed, play, walk         — community interactions
//   birth                    — offspring born from user's creature
//   transfer_offer           — someone offering ownership TO the user
//   breed (offspring post)   — someone bred a child using user's creature as parent
//
// Returns Array<NotificationItem> sorted newest first:
//   { type, actor, creatureAuthor, creaturePermlink, creatureName,
//     ts, extra }
// ============================================================

async function fetchNotificationsForUser(username, limit = 50) {
  if (!username) return [];
  const notifications = [];

  // ── Step 1: Get the user's own creature posts ──────────────
  // These are the posts others can reply to with feed/play/walk/birth/transfer_offer
  let ownPosts = [];
  try {
    const raw = await fetchPostsByUser(username, limit);
    ownPosts = Array.isArray(raw) ? raw : [];
  } catch { /* non-fatal */ }

  // Filter to SteemBiota creature posts only
  const ownCreaturePosts = ownPosts.filter(p => {
    try {
      const m = JSON.parse(p.json_metadata || '{}');
      return !!(m.steembiota && m.steembiota.genome);
    } catch { return false; }
  });

  // ── Step 2: For each creature, fetch replies and parse events ──
  await Promise.all(ownCreaturePosts.slice(0, 20).map(async (post) => {
    let replies = [];
    try { replies = await fetchAllReplies(post.author, post.permlink); } catch { return; }

    let sbName = post.author;
    try { sbName = JSON.parse(post.json_metadata || '{}').steembiota?.name || post.author; } catch {}

    for (const reply of replies) {
      if (reply.author === username) continue; // skip own replies
      let meta = {};
      try { meta = JSON.parse(reply.json_metadata || '{}'); } catch { continue; }
      if (!meta.steembiota) continue;

      const type  = meta.steembiota.type;
      const ts    = new Date(reply.created.endsWith('Z') ? reply.created : reply.created + 'Z');

      if (type === 'feed') {
        const food = meta.steembiota.food || 'food';
        notifications.push({
          type: 'feed',
          actor: reply.author,
          creatureAuthor: post.author,
          creaturePermlink: post.permlink,
          creatureName: sbName,
          ts,
          extra: { food }
        });
      } else if (type === 'play') {
        notifications.push({
          type: 'play',
          actor: reply.author,
          creatureAuthor: post.author,
          creaturePermlink: post.permlink,
          creatureName: sbName,
          ts,
          extra: {}
        });
      } else if (type === 'walk') {
        notifications.push({
          type: 'walk',
          actor: reply.author,
          creatureAuthor: post.author,
          creaturePermlink: post.permlink,
          creatureName: sbName,
          ts,
          extra: {}
        });
      } else if (type === 'birth') {
        const child = meta.steembiota.child || {};
        notifications.push({
          type: 'birth',
          actor: reply.author,
          creatureAuthor: post.author,
          creaturePermlink: post.permlink,
          creatureName: sbName,
          ts,
          extra: { childAuthor: child.author, childPermlink: child.permlink }
        });
      } else if (type === 'transfer_offer' && meta.steembiota.to === username) {
        // Someone offered this creature to the current user
        notifications.push({
          type: 'transfer_offer',
          actor: reply.author,
          creatureAuthor: post.author,
          creaturePermlink: post.permlink,
          creatureName: sbName,
          ts,
          extra: { offerPermlink: reply.permlink }
        });
      }
    }
  }));

  // ── Steps 3 & 4: Fetch the tag corpus ONCE, reuse for both scans ──────
  // A single fetchPostsByTag call covers both steps, halving the RPC cost.
  // Step 3 now covers BOTH creature and accessory posts so that accessory
  // transfer_offers also generate notifications for the named recipient.
  let sharedTagPosts = [];
  try {
    const raw = await fetchPostsByTag('steembiota', 100);
    sharedTagPosts = Array.isArray(raw) ? raw : [];
  } catch { /* non-fatal */ }

  // ── Step 3: Scan foreign steembiota posts for transfer_offers TO this user ──
  // Covers creatures AND accessories authored by others.
  try {
    const foreignPosts = sharedTagPosts.filter(p => {
      if (p.author === username) return false;
      try {
        const m = JSON.parse(p.json_metadata || '{}');
        // Accept any steembiota post with content (creature genome or accessory)
        return !!(m.steembiota?.genome || m.steembiota?.accessory);
      } catch { return false; }
    });

    await _throttledMap(foreignPosts.slice(0, 30), 5, async (post) => {
      let meta = {};
      try { meta = JSON.parse(post.json_metadata || '{}'); } catch { return; }

      let replies = [];
      try { replies = await fetchAllReplies(post.author, post.permlink); } catch { return; }

      // Item name: creature name or accessory name
      const sbName = meta.steembiota?.name
        || meta.steembiota?.accessory?.name
        || post.author;

      for (const reply of replies) {
        if (reply.author === username) continue;
        let rmeta = {};
        try { rmeta = JSON.parse(reply.json_metadata || '{}'); } catch { continue; }
        if (!rmeta.steembiota) continue;
        if (rmeta.steembiota.type !== 'transfer_offer') continue;
        if (rmeta.steembiota.to !== username) continue;

        // Check there is no subsequent cancel or accept (still pending)
        const offerPermlink = reply.permlink;
        const cancelled = replies.some(r => {
          if (r.author !== post.author) return false;
          let m = {}; try { m = JSON.parse(r.json_metadata || '{}'); } catch { return false; }
          if (m.steembiota?.type !== 'transfer_cancel') return false;
          return new Date(r.created) > new Date(reply.created);
        });
        const accepted = replies.some(r => {
          if (r.author !== username) return false;
          let m = {}; try { m = JSON.parse(r.json_metadata || '{}'); } catch { return false; }
          return m.steembiota?.type === 'transfer_accept' &&
                 m.steembiota?.offer_permlink === offerPermlink;
        });

        if (!cancelled && !accepted) {
          const ts = new Date(reply.created.endsWith('Z') ? reply.created : reply.created + 'Z');
          const alreadyHave = notifications.some(n =>
            n.type === 'transfer_offer' &&
            n.creatureAuthor === post.author &&
            n.creaturePermlink === post.permlink
          );
          if (!alreadyHave) {
            notifications.push({
              type: 'transfer_offer',
              actor: reply.author,
              creatureAuthor: post.author,
              creaturePermlink: post.permlink,
              creatureName: sbName,
              ts,
              extra: { offerPermlink }
            });
          }
        }
      }
    });
  } catch { /* non-fatal */ }

  // ── Step 4: Scan shared corpus for offspring where user's creature is a parent ──
  try {
    for (const post of sharedTagPosts) {
      if (post.author === username) continue;
      let meta = {};
      try { meta = JSON.parse(post.json_metadata || '{}'); } catch { continue; }
      const sb = meta.steembiota;
      if (!sb?.genome || sb.type !== 'offspring') continue;
      const pA = sb.parentA;
      const pB = sb.parentB;
      const usedUserCreature =
        (pA && pA.author === username) ||
        (pB && pB.author === username);
      if (!usedUserCreature) continue;

      const ts = new Date(post.created.endsWith('Z') ? post.created : post.created + 'Z');
      notifications.push({
        type: 'breed',
        actor: post.author,
        creatureAuthor: post.author,
        creaturePermlink: post.permlink,
        creatureName: sb.name || post.author,
        ts,
        extra: { parentA: pA, parentB: pB }
      });
    }
  } catch { /* non-fatal */ }

  // Sort newest first, deduplicate by (type+creatureAuthor+creaturePermlink+actor)
  const seen = new Set();
  return notifications
    .filter(n => {
      const key = `${n.type}::${n.actor}::${n.creatureAuthor}::${n.creaturePermlink}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.ts - a.ts);
}

// ============================================================
// OWNED CREATURES — resolves effective ownership from transfer chain
//
// Returns all SteemBiota creature posts where effectiveOwner === username.
// Includes both posts authored by username AND posts authored by others
// that have been transferred to username.
//
// Strategy (efficient):
//  1. Fetch user's own posts (fast path — most creatures stay with author)
//  2. Fetch all steembiota tag posts authored by others
//  3. For posts authored by others, fetch replies and check ownership chain
//     (only when the post has transfer-related replies — cheap heuristic)
// ============================================================

async function fetchCreaturesOwnedBy(username, limit = 100) {
  if (!username) return [];
  const results = [];

  // ── Own posts (fast path) ──────────────────────────────────
  // fetchPostsByUser uses getDiscussionsByBlog which includes resteems.
  // Filter strictly to posts authored by the user that have a creature genome.
  // Accessory posts (type:"accessory") do NOT have a genome field so they
  // are naturally excluded by the meta.steembiota?.genome check.
  try {
    const raw = await fetchPostsByUser(username, limit);
    const ownCreaturePosts = (Array.isArray(raw) ? raw : []).filter(p => {
      if (p.author !== username) return false;  // skip resteems
      try {
        const m = JSON.parse(p.json_metadata || '{}');
        return !!(m.steembiota?.genome);         // creatures only
      } catch { return false; }
    });

    await _throttledMap(ownCreaturePosts, 5, async (p) => {
      let meta = {};
      try { meta = JSON.parse(p.json_metadata || '{}'); } catch { return; }

      let replies = [];
      try { replies = await fetchAllReplies(p.author, p.permlink); } catch {}

      const hasTransferReplies = replies.some(r => {
        try {
          const m = JSON.parse(r.json_metadata || '{}');
          return ['transfer_offer','transfer_accept','transfer_cancel']
            .includes(m.steembiota?.type);
        } catch { return false; }
      });

      const effectiveOwner = hasTransferReplies
        ? parseOwnershipChain(replies, p.author).effectiveOwner
        : p.author;

      if (effectiveOwner === username) {
        results.push({ post: p, meta: meta.steembiota, effectiveOwner });
      }
    });
  } catch { /* non-fatal */ }

  // ── Incoming transfers (creatures authored by others) ──────
  try {
    const tagPosts = await fetchPostsByTag('steembiota', 100);
    const foreignCreaturePosts = (Array.isArray(tagPosts) ? tagPosts : []).filter(p => {
      if (p.author === username) return false;
      try {
        const m = JSON.parse(p.json_metadata || '{}');
        return !!(m.steembiota?.genome);  // creatures only, excludes accessories
      } catch { return false; }
    });

    await _throttledMap(foreignCreaturePosts, 5, async (p) => {
      let meta = {};
      try { meta = JSON.parse(p.json_metadata || '{}'); } catch { return; }

      let replies = [];
      try { replies = await fetchAllReplies(p.author, p.permlink); } catch { return; }

      const hasTransferReplies = replies.some(r => {
        try {
          const m = JSON.parse(r.json_metadata || '{}');
          return ['transfer_offer','transfer_accept','transfer_cancel']
            .includes(m.steembiota?.type);
        } catch { return false; }
      });
      if (!hasTransferReplies) return;

      const chain = parseOwnershipChain(replies, p.author);
      if (chain.effectiveOwner === username) {
        results.push({ post: p, meta: meta.steembiota, effectiveOwner: username });
      }
    });
  } catch { /* non-fatal */ }

  return results;
}
