import { getAccessToken, getServiceAccountCredentials, ServiceAccount } from "./shared/auth";
import {
  convertToSiteUrl,
  getPublishMetadata,
  requestIndexing,
  getEmojiForStatus,
  getPageIndexingStatus,
  convertToFilePath,
  checkSiteUrl,
  checkCustomUrls,
} from "./shared/gsc";
import { getSitemapPages } from "./shared/sitemap";
import { Status } from "./shared/types";
import { batch } from "./shared/utils";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";

const CACHE_TIMEOUT = 1000 * 60 * 60 * 24 * 14; // 14 days
export const QUOTA = {
  rpm: {
    retries: 3,
    waitingTime: 60000, // 1 minute
  },
};

export type IndexOptions = {
  client_email?: string;
  private_key?: string;
  path?: string;
  urls?: string[];
  quota?: {
    rpmRetry?: boolean; // read requests per minute: retry after waiting time
  };
};

/**
 * Indexes the specified domain or site URL.
 * @param input - The domain or site URL to index.
 * @param options - (Optional) Additional options for indexing.
 */
export const index = async (input: string = process.argv[2], options: IndexOptions = {}) => {
  if (!input) {
    console.error("❌ Please provide a domain or site URL as the first argument.");
    console.error("");
    process.exit(1);
  }

  if (!options.client_email) {
    options.client_email = process.env.GIS_CLIENT_EMAIL;
  }
  if (!options.private_key) {
    options.private_key = process.env.GIS_PRIVATE_KEY;
  }
  if (!options.path) {
    options.path = process.env.GIS_PATH;
  }
  if (!options.urls) {
    options.urls = process.env.GIS_URLS ? process.env.GIS_URLS.split(",") : undefined;
  }
  if (!options.quota) {
    options.quota = {
      rpmRetry: process.env.GIS_QUOTA_RPM_RETRY === "true",
    };
  }

  let credentials: ServiceAccount[] = [];
  if (options.client_email && options.private_key) {
    credentials = [{ client_email: options.client_email, private_key: options.private_key }];
  } else {
    credentials = getServiceAccountCredentials(options.path);
  }

  let siteUrl = convertToSiteUrl(input);
  console.log(`🔎 Processing site: ${siteUrl}`);
  const cachePath = path.join(".cache", `${convertToFilePath(siteUrl)}.json`);

  const validCredentials: { credential: ServiceAccount; accessToken: string }[] = [];
  let verifiedSiteUrl: string | undefined;

  for (const credential of credentials) {
    try {
      const accessToken = await getAccessToken(credential.client_email, credential.private_key);
      const url = await checkSiteUrl(accessToken, siteUrl);
      if (!verifiedSiteUrl) {
        verifiedSiteUrl = url;
      }
      validCredentials.push({ credential, accessToken });
    } catch (error) {
      console.warn(`⚠️ Service account ${credential.client_email} failed: ${(error as Error).message}`);
    }
  }

  if (validCredentials.length === 0 || !verifiedSiteUrl) {
    console.error("❌ Failed to find any service account with access to this site.");
    console.error("");
    process.exit(1);
  }

  siteUrl = verifiedSiteUrl;
  let currentAccountIndex = 0;

  const rotateAccount = async () => {
    currentAccountIndex = (currentAccountIndex + 1) % validCredentials.length;
    const next = validCredentials[currentAccountIndex];
    console.log(`🔄 Rotating to service account: ${next.credential.client_email}`);
    next.accessToken = await getAccessToken(next.credential.client_email, next.credential.private_key);
    return next.accessToken;
  };

  let pages = options.urls || [];
  if (pages.length === 0) {
    console.log(`🔎 Fetching sitemaps and pages...`);
    const [sitemaps, pagesFromSitemaps] = await getSitemapPages(validCredentials[currentAccountIndex].accessToken, siteUrl);

    if (sitemaps.length === 0) {
      console.error("❌ No sitemaps found, add them to Google Search Console and try again.");
      console.error("");
      process.exit(1);
    }

    pages = pagesFromSitemaps;

    console.log(`👉 Found ${pages.length} URLs in ${sitemaps.length} sitemap`);
  } else {
    pages = checkCustomUrls(siteUrl, pages);
    console.log(`👉 Found ${pages.length} URLs in the provided list`);
  }

  const statusPerUrl: Record<string, { status: Status; lastCheckedAt: string }> = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, "utf8"))
    : {};
  const pagesPerStatus: Record<Status, string[]> = {
    [Status.SubmittedAndIndexed]: [],
    [Status.DuplicateWithoutUserSelectedCanonical]: [],
    [Status.CrawledCurrentlyNotIndexed]: [],
    [Status.DiscoveredCurrentlyNotIndexed]: [],
    [Status.PageWithRedirect]: [],
    [Status.URLIsUnknownToGoogle]: [],
    [Status.RateLimited]: [],
    [Status.Forbidden]: [],
    [Status.Error]: [],
  };

  const indexableStatuses = [
    Status.DiscoveredCurrentlyNotIndexed,
    Status.CrawledCurrentlyNotIndexed,
    Status.URLIsUnknownToGoogle,
    Status.Forbidden,
    Status.Error,
    Status.RateLimited,
  ];

  const shouldRecheck = (status: Status, lastCheckedAt: string) => {
    const shouldIndexIt = indexableStatuses.includes(status);
    const isOld = new Date(lastCheckedAt) < new Date(Date.now() - CACHE_TIMEOUT);
    return shouldIndexIt && isOld;
  };

  await batch(
    async (url) => {
      let result = statusPerUrl[url];
      if (!result || shouldRecheck(result.status, result.lastCheckedAt)) {
        let status: Status = Status.Error;
        let rotationCount = 0;

        while (rotationCount < validCredentials.length) {
          status = await getPageIndexingStatus(validCredentials[currentAccountIndex].accessToken, siteUrl, url);

          if (status === Status.RateLimited) {
            await rotateAccount();
            rotationCount++;
            continue;
          }

          if (status === Status.Forbidden) {
            await rotateAccount();
            rotationCount++;
            continue;
          }

          break;
        }

        result = { status, lastCheckedAt: new Date().toISOString() };
        statusPerUrl[url] = result;
      }

      pagesPerStatus[result.status] = pagesPerStatus[result.status] ? [...pagesPerStatus[result.status], url] : [url];
    },
    pages,
    50,
    (batchIndex, batchCount) => {
      console.log(`📦 Batch ${batchIndex + 1} of ${batchCount} complete`);
    }
  );

  console.log(``);
  console.log(`👍 Done, here's the status of all ${pages.length} pages:`);
  mkdirSync(".cache", { recursive: true });
  writeFileSync(cachePath, JSON.stringify(statusPerUrl, null, 2));

  for (const status of Object.keys(pagesPerStatus)) {
    const pages = pagesPerStatus[status as Status];
    if (pages.length === 0) continue;
    console.log(`• ${getEmojiForStatus(status as Status)} ${status}: ${pages.length} pages`);
  }
  console.log("");

  const indexablePages = Object.entries(pagesPerStatus).flatMap(([status, pages]) =>
    indexableStatuses.includes(status as Status) ? pages : []
  );

  if (indexablePages.length === 0) {
    console.log(`✨ There are no pages that can be indexed. Everything is already indexed!`);
  } else {
    console.log(`✨ Found ${indexablePages.length} pages that can be indexed.`);
    indexablePages.forEach((url) => console.log(`• ${url}`));
  }
  console.log(``);

  for (const url of indexablePages) {
    console.log(`📄 Processing url: ${url}`);

    let processed = false;
    let rotationCount = 0;

    while (rotationCount < validCredentials.length) {
      const { accessToken } = validCredentials[currentAccountIndex];
      const status = await getPublishMetadata(accessToken, url, {
        retriesOnRateLimit: options.quota.rpmRetry ? QUOTA.rpm.retries : 0,
      });

      if (status === 429 || status === 403) {
        await rotateAccount();
        rotationCount++;
        continue;
      }

      if (status === 404) {
        const requestStatus = await requestIndexing(accessToken, url);
        if (requestStatus === 429 || requestStatus === 403) {
          await rotateAccount();
          rotationCount++;
          continue;
        }
        console.log("🚀 Indexing requested successfully. It may take a few days for Google to process it.");
      } else if (status < 400) {
        console.log(`🕛 Indexing already requested previously. It may take a few days for Google to process it.`);
      }
      processed = true;
      break;
    }

    if (!processed) {
      console.error(`❌ Failed to process URL ${url} with any of the provided service accounts.`);
    }
    console.log(``);
  }

  console.log(`👍 All done!`);
  console.log(`💖 Brought to you by https://seogets.com - SEO Analytics.`);
  console.log(``);
};

export * from "./shared";
