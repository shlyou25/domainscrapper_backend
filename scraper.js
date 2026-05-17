const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const pLimit = require("p-limit").default;
const cors = require("cors");
const puppeteer = require("puppeteer-core");

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "https://domainscrapper.netlify.app",
  "https://domainscrapping.netlify.app"
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.includes(origin) ||
        origin.includes("trycloudflare.com")
      )
        return callback(null, true);
      return callback(new Error("CORS not allowed"));
    },
  })
);

app.use(express.json());

const PORT = process.env.PORT || 5001;

const http = axios.create({
  timeout: 10000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122 Safari/537.36",
  },
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err.message);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


const safeAxiosGet = async (url) => {
  try {
    const res = await http.get(url, {
      validateStatus: () => true,
      headers: { Referer: url },
    });

    if (res.status >= 400) {
      console.log(`⚠️ Blocked (${res.status}) → ${url}`);
      return null;
    }

    return res.data;
  } catch (err) {
    console.log("Axios error:", err.message);
    return null;
  }
};

const normalizeUrl = (input) => {
  if (!input) return "";

  let url = input.trim();

  // remove trailing dot
  url = url.replace(/\.+$/, "");

  // add protocol if missing
  if (!/^https?:\/\//i.test(url)) {
    url = "http://" + url;
  }

  return url;
};

// const isRealDomain = (domain) =>
//   /^[a-z0-9-]+\.[a-z]{2,}$/i.test(domain);

const extractDomains = ($) => {
  const domains = new Set();

  $("body *").each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    if (["script", "style", "noscript"].includes(tag)) return;

    const text = $(el).clone().children().remove().end().text().trim();

    if (!text || text.length > 80) return;

    const match = text.match(/^[a-z0-9-]+\.[a-z]{2,}$/i);
    if (match) domains.add(match[0]);
  });

  return [...domains];
};

const scrapeWithAxios = async (url) => {
  const data = await safeAxiosGet(url);

  if (!data) return [];

  const $ = cheerio.load(data);
  return extractDomains($);
};

const scrapeWithBrowser = async (url) => {
  console.log("Using Puppeteer...");

  let browser;

  try {
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    await new Promise((r) => setTimeout(r, 3000));

    const content = await page.content();

    const $ = cheerio.load(content);
    return extractDomains($);
  } catch (err) {
    console.log("Puppeteer failed:", err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
};

const extractPageNumber = (url) => {
  try {
    const parsed = new URL(url);

    // ✅ query param style
    const queryPage = parsed.searchParams.get("page");
    if (queryPage && !isNaN(queryPage)) {
      return parseInt(queryPage);
    }

    // ✅ path style
    const pathMatch = parsed.pathname.match(/\/page\/(\d+)/);
    if (pathMatch) {
      return parseInt(pathMatch[1]);
    }

    return 1;
  } catch {
    return 1;
  }
};

const buildPageUrl = (templateUrl, page) => {
  try {
    const parsed = new URL(templateUrl);

    // ✅ query param style
    if (parsed.searchParams.has("page")) {
      parsed.searchParams.set("page", page);
      return parsed.toString();
    }

    // ✅ path style
    if (/\/page\/\d+/.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(
        /\/page\/\d+/,
        `/page/${page}`
      );

      return parsed.toString();
    }

    return templateUrl;
  } catch {
    return templateUrl;
  }
};

const scrapePagination = async (startUrl, endUrl) => {
  const start = extractPageNumber(startUrl);
  const end = extractPageNumber(endUrl);

  console.log(`Start Page: ${start}`);
  console.log(`End Page: ${end}`);

  let allDomains = new Set();

  for (let i = start; i <= end; i++) {
    const pageUrl = buildPageUrl(startUrl, i);

    console.log(`Scraping: ${pageUrl}`);

    try {
      let domains = await scrapeWithAxios(pageUrl);

      // fallback to browser
      if (!domains || domains.length < 5) {
        console.log(`🔄 Puppeteer fallback page ${i}`);
        domains = await scrapeWithBrowser(pageUrl);
      }

      domains.forEach((d) => allDomains.add(d));

      await sleep(300);
    } catch (err) {
      console.log(`❌ Page ${i} failed`, err.message);
    }
  }

  return [...allDomains];
};

const checkDomainsFast = async (domains) => {
  const limit = pLimit(30);

  return Promise.all(
    domains.map((domain) =>
      limit(async () => {
        try {
          const res = await http.head(`http://${domain}`, {
            timeout: 3000,
            validateStatus: () => true,
          });

          return {
            domain,
            finalUrl:
              res.request?.res?.responseUrl || `http://${domain}`,
            status: res.status,
          };
        } catch {
          return {
            domain,
            finalUrl: `http://${domain}`,
            status: "failed",
          };
        }
      })
    )
  );
};

const scrapeHandler = async ({
  url,
  paginationMode,
  startUrl,
  endUrl,
}) => {
  let domains = [];

  try {
    if (paginationMode) {
      domains = await scrapePagination(startUrl, endUrl);
    } else {
      domains = await scrapeWithAxios(url);

      if (!domains || domains.length < 5) {
        console.log("Switching to browser...");
        domains = await scrapeWithBrowser(url);
      }
    }
  } catch (err) {
    console.log("Handler fallback to browser");
    domains = await scrapeWithBrowser(url);
  }

  domains = [...new Set(domains)];

  const results = await checkDomainsFast(domains);

  return {
    total: domains.length,
    results,
  };
};

app.post("/scrape", async (req, res) => {
  const { url, paginationMode, startUrl, endUrl } = req.body;

  const cleanUrl = url ? normalizeUrl(url) : "";
  const cleanStartUrl = startUrl ? normalizeUrl(startUrl) : "";
  const cleanEndUrl = endUrl ? normalizeUrl(endUrl) : "";
  try {
    const data = await scrapeHandler({
      url: cleanUrl,
      paginationMode,
      startUrl: cleanStartUrl,
      endUrl: cleanEndUrl,
    });

    res.json(data);
  } catch (err) {
    console.error("Final error:", err.message);

    res.json({
      total: 0,
      results: [],
      error: "Handled gracefully",
    });
  }
});
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});