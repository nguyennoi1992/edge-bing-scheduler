// words.js

// ── Diverse word bank covering everyday life, not just tech ──
export const WORD_BANK = {
  // Everyday nouns people actually search for
  nouns: [
    "recipe", "restaurant", "movie", "song", "book", "hotel", "flight",
    "weather", "score", "schedule", "salary", "price", "review", "tutorial",
    "laptop", "phone", "headphones", "camera", "watch", "tablet", "speaker",
    "coffee", "tea", "pizza", "sushi", "pasta", "cake", "smoothie",
    "workout", "yoga", "meditation", "running", "hiking", "swimming",
    "garden", "plant", "flower", "tree", "dog", "cat", "fish",
    "apartment", "house", "furniture", "kitchen", "bathroom", "bedroom",
    "vaccine", "vitamin", "sleep", "diet", "stress", "anxiety", "therapy",
    "budget", "savings", "investment", "mortgage", "insurance", "tax",
    "resume", "interview", "career", "promotion", "freelance", "remote work",
    "painting", "photography", "guitar", "piano", "drawing", "pottery",
    "podcast", "documentary", "series", "concert", "festival", "exhibition",
    "birthday", "wedding", "holiday", "vacation", "road trip", "camping",
    "algorithm", "database", "framework", "API", "cloud", "server",
    "startup", "app", "website", "browser", "extension", "plugin",
    "công nghệ", "thuật toán", "dữ liệu", "hệ sinh thái", "phần mềm", "giải pháp",
    "đám mây", "bảo mật", "mạng lưới", "trí tuệ nhân tạo", "ứng dụng", "công cụ",
    "món ăn", "du lịch", "sức khỏe", "thời tiết", "việc làm", "nhà cửa",
    "điện thoại", "máy tính", "xe hơi", "sách", "phim", "nhạc",
  ],

  // Natural action verbs
  verbs: [
    "learn", "fix", "build", "improve", "compare", "choose", "find",
    "make", "cook", "clean", "organize", "plan", "start", "grow",
    "upgrade", "install", "remove", "replace", "repair", "customize",
    "download", "stream", "record", "edit", "share", "save", "backup",
    "train", "practice", "study", "prepare", "schedule", "manage",
    "decorate", "paint", "design", "style", "arrange", "convert",
    "troubleshoot", "debug", "optimize", "deploy", "configure", "automate",
    "tối ưu hóa", "phân tích", "phát triển", "tích hợp", "triển khai", "đánh giá",
    "kiểm thử", "nâng cấp", "chẩn đoán", "tổng hợp", "xử lý", "sửa chữa",
    "nấu", "tìm kiếm", "so sánh", "lựa chọn", "học", "tập",
  ],

  // More natural adjectives
  adjectives: [
    "best", "cheap", "free", "easy", "quick", "healthy", "natural",
    "popular", "trending", "affordable", "professional", "beginner",
    "advanced", "simple", "modern", "classic", "vintage", "organic",
    "wireless", "portable", "waterproof", "lightweight", "durable",
    "comfortable", "spacious", "cozy", "quiet", "bright", "warm",
    "effective", "reliable", "safe", "eco-friendly", "energy-efficient",
    "handmade", "homemade", "local", "seasonal", "traditional",
    "vegan", "gluten-free", "low-carb", "high-protein", "sugar-free",
    "remote", "part-time", "full-time", "entry-level", "senior",
    "open-source", "cross-platform", "real-time", "high-performance",
    "mạnh mẽ", "linh hoạt", "hiệu quả", "bền vững", "toàn diện",
    "chính xác", "tự động", "nhanh chóng", "thông minh", "tiện lợi",
    "rẻ", "tốt nhất", "phổ biến", "đơn giản", "chất lượng",
  ],

  // Real topics people search
  topics: [
    "machine learning", "web development", "data science", "cybersecurity",
    "cloud computing", "mobile development", "game development", "AI",
    "home improvement", "interior design", "gardening", "cooking",
    "fitness", "mental health", "nutrition", "skincare", "haircare",
    "personal finance", "cryptocurrency", "stock market", "real estate",
    "travel destinations", "camping spots", "road trips", "backpacking",
    "photography tips", "video editing", "music production", "podcasting",
    "parenting", "education", "language learning", "online courses",
    "sustainable living", "minimalism", "zero waste", "solar energy",
    "electric vehicles", "smart home", "wearable tech", "3D printing",
    "streaming services", "social media", "content creation", "blogging",
    "remote work", "productivity", "time management", "side hustle",
    "climate change", "space exploration", "ocean conservation",
    "world history", "philosophy", "psychology", "economics",
    "lập trình web", "học máy", "khoa học dữ liệu", "thiết kế giao diện",
    "an toàn thông tin", "năng lượng tái tạo", "chuyển đổi số", "kinh tế tuần hoàn",
    "thương mại điện tử", "phát triển bền vững", "quản lý dự án", "công nghệ thông tin",
    "du lịch Việt Nam", "ẩm thực Việt Nam", "lịch sử Việt Nam", "văn hóa Việt Nam",
  ],

  // Specific brands/products people search for naturally
  brands: [
    "Windows 11", "Microsoft Edge", "Xbox", "Surface", "Copilot",
    "ChatGPT", "iPhone", "Samsung Galaxy", "Google Pixel",
    "Netflix", "Spotify", "YouTube", "TikTok", "Instagram",
    "Amazon", "Shopee", "Lazada", "Grab", "Airbnb",
    "Tesla", "Nike", "Adidas", "IKEA", "Uniqlo",
    "VS Code", "GitHub", "Docker", "Python", "React",
    "Notion", "Figma", "Canva", "Slack", "Zoom",
  ],

  // Place names for location-based searches
  places: [
    "New York", "Tokyo", "Paris", "London", "Seoul", "Singapore",
    "Bali", "Dubai", "Barcelona", "Amsterdam", "Sydney", "Toronto",
    "Hà Nội", "Hồ Chí Minh", "Đà Nẵng", "Phú Quốc", "Hội An",
    "Nha Trang", "Đà Lạt", "Sapa", "Huế", "Vũng Tàu",
    "San Francisco", "Los Angeles", "Chicago", "Seattle", "Austin",
    "Berlin", "Munich", "Rome", "Milan", "Lisbon", "Prague",
  ],

  // Time-related words for current/trending queries
  timeWords: [
    "2025", "2026", "today", "this week", "this month", "this year",
    "latest", "new", "upcoming", "current", "recent", "updated",
    "hôm nay", "tuần này", "tháng này", "năm 2025", "năm 2026", "mới nhất",
  ],
};

// ── Helpers ──

export function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function maybe(chance = 0.5) {
  return Math.random() < chance;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Current month for seasonal awareness
function currentMonth() {
  return new Date().toLocaleString("en-US", { month: "long" });
}
function currentYear() {
  return new Date().getFullYear().toString();
}

// ── Query templates that mimic real human searches ──

const EN_PATTERNS = [
  // Direct questions (most common search type)
  () => `what is ${randomFrom(WORD_BANK.topics)}`,
  () => `how does ${randomFrom(WORD_BANK.nouns)} work`,
  () => `why is ${randomFrom(WORD_BANK.nouns)} ${randomFrom(WORD_BANK.adjectives)}`,
  () => `when to ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)}`,
  () => `where to ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.adjectives)} ${randomFrom(WORD_BANK.nouns)}`,
  () => `who invented ${randomFrom(WORD_BANK.nouns)}`,
  () => `can you ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)} at home`,
  () => `is ${randomFrom(WORD_BANK.nouns)} worth it ${currentYear()}`,

  // How-to guides
  () => `how to ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)} step by step`,
  () => `how to ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)} for beginners`,
  () => `how to ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)} without ${randomFrom(WORD_BANK.nouns)}`,
  () => `how to ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)} on a budget`,
  () => `${randomFrom(WORD_BANK.nouns)} tips and tricks`,

  // Best/top lists
  () => `best ${randomFrom(WORD_BANK.nouns)} ${currentYear()}`,
  () => `best ${randomFrom(WORD_BANK.adjectives)} ${randomFrom(WORD_BANK.nouns)} under $${randomInt(50, 500)}`,
  () => `top ${randomInt(5, 15)} ${randomFrom(WORD_BANK.nouns)} for ${randomFrom(WORD_BANK.topics)}`,
  () => `best ${randomFrom(WORD_BANK.nouns)} in ${randomFrom(WORD_BANK.places)}`,
  () => `${randomFrom(WORD_BANK.adjectives)} ${randomFrom(WORD_BANK.nouns)} recommendations`,

  // Comparisons
  () => `${randomFrom(WORD_BANK.nouns)} vs ${randomFrom(WORD_BANK.nouns)} which is better`,
  () => `${randomFrom(WORD_BANK.brands)} vs ${randomFrom(WORD_BANK.brands)} ${currentYear()}`,
  () => `${randomFrom(WORD_BANK.nouns)} pros and cons`,
  () => `difference between ${randomFrom(WORD_BANK.nouns)} and ${randomFrom(WORD_BANK.nouns)}`,

  // Reviews and shopping
  () => `${randomFrom(WORD_BANK.brands)} review ${currentYear()}`,
  () => `${randomFrom(WORD_BANK.brands)} ${randomFrom(WORD_BANK.nouns)} review`,
  () => `is ${randomFrom(WORD_BANK.brands)} good for ${randomFrom(WORD_BANK.topics)}`,
  () => `${randomFrom(WORD_BANK.adjectives)} ${randomFrom(WORD_BANK.nouns)} deals`,
  () => `${randomFrom(WORD_BANK.nouns)} sale ${randomFrom(WORD_BANK.timeWords)}`,

  // Location-based
  () => `things to do in ${randomFrom(WORD_BANK.places)}`,
  () => `best ${randomFrom(WORD_BANK.nouns)} in ${randomFrom(WORD_BANK.places)}`,
  () => `${randomFrom(WORD_BANK.places)} ${randomFrom(WORD_BANK.nouns)} guide`,
  () => `${randomFrom(WORD_BANK.places)} travel tips ${currentYear()}`,
  () => `${randomFrom(WORD_BANK.nouns)} near ${randomFrom(WORD_BANK.places)}`,

  // Trending / news
  () => `${randomFrom(WORD_BANK.topics)} news ${randomFrom(WORD_BANK.timeWords)}`,
  () => `${randomFrom(WORD_BANK.topics)} trends ${currentYear()}`,
  () => `what happened with ${randomFrom(WORD_BANK.brands)} ${randomFrom(WORD_BANK.timeWords)}`,
  () => `${randomFrom(WORD_BANK.brands)} ${randomFrom(WORD_BANK.timeWords)} update`,

  // Problem-solving
  () => `${randomFrom(WORD_BANK.nouns)} not working how to fix`,
  () => `why is my ${randomFrom(WORD_BANK.nouns)} so slow`,
  () => `${randomFrom(WORD_BANK.brands)} ${randomFrom(WORD_BANK.nouns)} troubleshooting`,
  () => `${randomFrom(WORD_BANK.nouns)} error solutions`,
  () => `how to fix ${randomFrom(WORD_BANK.nouns)} on ${randomFrom(WORD_BANK.brands)}`,

  // Conversational / casual
  () => `what to ${randomFrom(WORD_BANK.verbs)} ${randomFrom(["today", "this weekend", "tonight", "for dinner", "for fun"])}`,
  () => `${randomFrom(WORD_BANK.adjectives)} ${randomFrom(WORD_BANK.nouns)} ideas`,
  () => `${randomFrom(WORD_BANK.adjectives)} ${randomFrom(WORD_BANK.nouns)} for ${randomFrom(["beginners", "students", "families", "couples", "kids", "seniors"])}`,
  () => `should I ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)}`,
  () => `${randomFrom(WORD_BANK.nouns)} meaning`,

  // Recipes and food
  () => `${randomFrom(WORD_BANK.adjectives)} ${randomFrom(["chicken", "pasta", "soup", "salad", "cake", "bread", "steak", "rice", "noodles"])} recipe`,
  () => `how to make ${randomFrom(["pizza", "sushi", "coffee", "smoothie", "pancakes", "tacos", "curry", "ramen"])} at home`,
  () => `${randomFrom(["breakfast", "lunch", "dinner", "snack", "dessert"])} ideas ${randomFrom(["quick", "healthy", "easy", "cheap"])}`,

  // Entertainment
  () => `${randomFrom(["movies", "shows", "games", "books", "songs", "anime", "podcasts"])} like ${randomFrom(WORD_BANK.brands)}`,
  () => `best ${randomFrom(["movies", "TV shows", "video games", "books", "albums"])} ${currentYear()}`,
  () => `${randomFrom(WORD_BANK.brands)} ${randomFrom(["release date", "trailer", "cast", "review", "spoilers"])}`,

  // Seasonal
  () => `${currentMonth()} ${randomFrom(["events", "deals", "weather", "holidays", "activities"])} ${randomFrom(WORD_BANK.places)}`,
  () => `${randomFrom(WORD_BANK.nouns)} ${currentMonth()} ${currentYear()}`,
];

const VI_PATTERNS = [
  // Direct questions
  () => `${randomFrom(WORD_BANK.nouns)} là gì`,
  () => `tại sao ${randomFrom(WORD_BANK.nouns)} lại ${randomFrom(WORD_BANK.adjectives)}`,
  () => `khi nào nên ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)}`,
  () => `${randomFrom(WORD_BANK.nouns)} có tốt không`,
  () => `${randomFrom(WORD_BANK.nouns)} giá bao nhiêu`,

  // How-to
  () => `cách ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)} đơn giản nhất`,
  () => `hướng dẫn ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)} chi tiết`,
  () => `cách ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)} cho người mới bắt đầu`,
  () => `mẹo ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)} hiệu quả`,
  () => `bí quyết ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)} nhanh chóng`,

  // Best/top lists
  () => `top ${randomInt(5, 10)} ${randomFrom(WORD_BANK.nouns)} ${randomFrom(WORD_BANK.adjectives)} nhất ${currentYear()}`,
  () => `${randomFrom(WORD_BANK.nouns)} nào tốt nhất hiện nay`,
  () => `gợi ý ${randomFrom(WORD_BANK.nouns)} ${randomFrom(WORD_BANK.adjectives)}`,
  () => `danh sách ${randomFrom(WORD_BANK.nouns)} đáng ${randomFrom(WORD_BANK.verbs)} nhất`,

  // Comparisons
  () => `so sánh ${randomFrom(WORD_BANK.nouns)} và ${randomFrom(WORD_BANK.nouns)}`,
  () => `${randomFrom(WORD_BANK.brands)} hay ${randomFrom(WORD_BANK.brands)} tốt hơn`,
  () => `nên chọn ${randomFrom(WORD_BANK.nouns)} nào`,
  () => `ưu nhược điểm của ${randomFrom(WORD_BANK.nouns)}`,

  // Reviews
  () => `đánh giá ${randomFrom(WORD_BANK.brands)} ${currentYear()}`,
  () => `review ${randomFrom(WORD_BANK.nouns)} ${randomFrom(WORD_BANK.adjectives)}`,
  () => `${randomFrom(WORD_BANK.brands)} có đáng mua không`,
  () => `trải nghiệm ${randomFrom(WORD_BANK.nouns)} sau ${randomInt(1, 12)} tháng sử dụng`,

  // Location-based
  () => `${randomFrom(WORD_BANK.nouns)} ở ${randomFrom(WORD_BANK.places)} ở đâu`,
  () => `địa điểm ${randomFrom(WORD_BANK.nouns)} tại ${randomFrom(WORD_BANK.places)}`,
  () => `du lịch ${randomFrom(WORD_BANK.places)} nên đi đâu`,
  () => `${randomFrom(WORD_BANK.places)} có gì hay`,

  // Trending
  () => `xu hướng ${randomFrom(WORD_BANK.topics)} ${currentYear()}`,
  () => `tin tức ${randomFrom(WORD_BANK.topics)} ${randomFrom(WORD_BANK.timeWords)}`,
  () => `${randomFrom(WORD_BANK.topics)} nổi bật ${randomFrom(WORD_BANK.timeWords)}`,

  // Problem-solving
  () => `${randomFrom(WORD_BANK.nouns)} bị lỗi phải làm sao`,
  () => `cách sửa lỗi ${randomFrom(WORD_BANK.nouns)}`,
  () => `tại sao ${randomFrom(WORD_BANK.nouns)} không hoạt động`,
  () => `khắc phục ${randomFrom(WORD_BANK.nouns)} bị ${randomFrom(["chậm", "đơ", "hỏng", "lỗi", "treo"])}`,

  // Food
  () => `cách nấu ${randomFrom(["phở", "bún bò", "bánh mì", "gỏi cuốn", "cơm tấm", "chả giò", "bún chả"])} ngon`,
  () => `công thức ${randomFrom(WORD_BANK.nouns)} đơn giản tại nhà`,
  () => `${randomFrom(["ăn gì", "uống gì", "đi đâu"])} ${randomFrom(["hôm nay", "cuối tuần", "tối nay"])}`,

  // Casual / conversational
  () => `nên ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)} không`,
  () => `${randomFrom(WORD_BANK.nouns)} cho ${randomFrom(["sinh viên", "gia đình", "người mới", "dân văn phòng"])}`,
  () => `kinh nghiệm ${randomFrom(WORD_BANK.verbs)} ${randomFrom(WORD_BANK.nouns)}`,
  () => `tài liệu học ${randomFrom(WORD_BANK.topics)} từ cơ bản đến nâng cao`,
];

export function makeRandomQuery() {
  // 60% English, 40% Vietnamese for natural mix
  const patterns = maybe(0.6) ? EN_PATTERNS : VI_PATTERNS;
  const generator = randomFrom(patterns);

  let query = generator();

  // Occasional typo simulation (very rare, ~3%) for realism
  if (maybe(0.03) && query.length > 10) {
    const pos = randomInt(3, query.length - 3);
    query = query.slice(0, pos) + query.slice(pos + 1);
  }

  return query;
}

/** Build N queries mixing custom list + random generator, ensuring no consecutive duplicates */
export function buildQueries({ count, customList }) {
  const queries = [];
  const custom = (customList || [])
    .map(s => s.trim())
    .filter(Boolean);

  let lastQuery = "";
  for (let i = 0; i < count; i++) {
    let q;
    let attempts = 0;
    do {
      if (custom.length && maybe(0.5)) {
        q = randomFrom(custom);
      } else {
        q = makeRandomQuery();
      }
      attempts++;
    } while (q === lastQuery && attempts < 5);

    queries.push(q);
    lastQuery = q;
  }
  return queries;
}
