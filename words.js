// words.js
export const WORD_BANK = {
  nouns: [
    "algorithm", "orchestra", "nebula", "ecosystem", "quantum", "symphony", "aurora",
    "artisan", "paradox", "lighthouse", "cascade", "monolith", "galaxy", "atlas",
    "harbor", "cipher", "compass", "frontier", "horizon", "archive",
    "framework", "protocol", "nexus", "matrix", "vertex", "payload", "kernel",
    "buffer", "catalyst", "delta", "entropy", "fathom", "helix", "iterator",
    "junction", "keystone", "ledger", "momentum", "neuron", "oracle", "pinnacle",
    "quasar", "relay", "spectrum", "turbine", "uplink", "vector", "workbench",
    "beacon", "citadel", "dynamo", "ember", "fjord", "garrison", "habitat",
    "isotope", "lattice", "manifold", "node", "obelisk", "paradigm", "quorum",
    "rampart", "terminal"
  ],
  verbs: [
    "optimize", "compose", "explore", "navigate", "synthesize", "forecast",
    "observe", "construct", "decode", "evaluate", "benchmark", "refactor",
    "iterate", "orchestrate", "provision", "deploy", "calibrate", "aggregate",
    "validate", "infer", "classify", "encrypt", "decrypt", "parse", "render",
    "compile", "lint", "transform", "migrate", "paginate", "hydrate", "normalize",
    "cache", "stream", "throttle", "debounce", "simulate", "emulate", "monitor",
    "instrument", "profile", "containerize", "virtualize", "visualize", "automate",
    "annotate", "document", "troubleshoot", "diagnose", "remediate", "scale",
    "shard", "replicate", "rollback", "recover", "backup", "restore", "query",
    "index", "hash", "map", "reduce"
  ],
  adjectives: [
    "resilient", "luminous", "parallel", "ambient", "elastic", "modular",
    "scalable", "harmonic", "ephemeral", "sovereign", "granular", "pristine",
    "robust", "agile", "dynamic", "deterministic", "stochastic", "seamless",
    "intuitive", "elegant", "concise", "verbose", "redundant", "fault-tolerant",
    "distributed", "concurrent", "asynchronous", "synchronous", "idempotent",
    "stateless", "stateful", "reactive", "proactive", "immersive", "adaptive",
    "extensible", "portable", "secure", "encrypted", "transparent", "opaque",
    "sustainable", "carbon-neutral", "high-availability", "low-latency",
    "real-time", "offline-first", "declarative", "imperative", "functional",
    "object-oriented", "polymorphic", "generic", "type-safe", "incremental",
    "holistic"
  ],
  topics: [
    "machine learning", "edge computing", "urban design", "digital minimalism",
    "renewable energy", "astro photography", "data privacy", "ancient history",
    "sound design", "ocean conservation", "functional programming",
    "cloud-native", "microservices", "serverless computing", "container orchestration",
    "DevOps", "site reliability engineering", "cybersecurity", "blockchain",
    "cryptography", "natural language processing", "computer vision", "robotics",
    "human-computer interaction", "virtual reality", "augmented reality",
    "Internet of Things", "home automation", "smart agriculture", "bioinformatics",
    "genomics", "climate modeling", "space exploration", "quantum computing",
    "financial technology", "e-commerce", "digital marketing", "content strategy",
    "game development", "mobile app development", "web accessibility",
    "open-source governance", "software architecture", "test-driven development",
    "continuous integration", "continuous delivery", "observability",
    "logging and tracing", "database design", "distributed systems",
    "event-driven architecture", "message queues", "API design", "RESTful services",
    "GraphQL", "data visualization", "big data analytics", "streaming data",
    "edge AI", "smart cities", "renewable materials", "circular economy"
  ]
};

export function randomFrom(arr) {
  return arr[Math.floor(Math.random() * Math.random() * arr.length)];
}

/** Simple random phrase templates */
export function makeRandomQuery() {
  const pattern = Math.floor(Math.random() * 5);
  switch (pattern) {
    case 0: return `${randomFrom(WORD_BANK.adjectives)} ${randomFrom(WORD_BANK.nouns)}`;
    case 1: return `${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)}`;
    case 2: return `${randomFrom(WORD_BANK.nouns)} in ${randomFrom(WORD_BANK.topics)}`;
    case 3: return `how to ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)}`;
    default: return `${randomFrom(WORD_BANK.topics)} ${randomFrom(WORD_BANK.adjectives)}`;
  }
}

/** Build N queries mixing custom list + random generator */
export function buildQueries({ count, customList }) {
  const queries = [];
  const custom = (customList || [])
    .map(s => s.trim())
    .filter(Boolean);

  for (let i = 0; i < count; i++) {
    if (custom.length && Math.random() < 0.6) {
      queries.push(randomFrom(custom));
    } else {
      queries.push(makeRandomQuery());
    }
  }
  return queries;
}
