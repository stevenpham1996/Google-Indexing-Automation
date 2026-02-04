import { google } from "googleapis";
import fs from "fs";
import path from "path";
import os from "os";

export type ServiceAccount = {
  client_email: string;
  private_key: string;
};

/**
 * Loads service account credentials from a file.
 * Supports both a single object and an array of objects.
 * @param customPath - (Optional) Custom path to the service account JSON file.
 * @returns An array of service account credentials.
 */
export function getServiceAccountCredentials(customPath?: string): ServiceAccount[] {
  const filePath = "service_account.json";
  const filePathFromHome = path.join(os.homedir(), ".gis", "service_account.json");
  const isFile = fs.existsSync(filePath);
  const isFileFromHome = fs.existsSync(filePathFromHome);
  const isCustomFile = !!customPath && fs.existsSync(customPath);

  if (!isFile && !isFileFromHome && !isCustomFile) {
    console.error(`❌ ${filePath} not found, please follow the instructions in README.md`);
    console.error("");
    process.exit(1);
  }

  const content = fs.readFileSync(
    !!customPath && isCustomFile ? customPath : isFile ? filePath : filePathFromHome,
    "utf8"
  );
  const key = JSON.parse(content);

  if (Array.isArray(key)) {
    return key;
  }

  return [key];
}

/**
 * Retrieves an access token for Google APIs using service account credentials.
 * @param client_email - The client email of the service account.
 * @param private_key - The private key of the service account.
 * @returns The access token.
 */
export async function getAccessToken(client_email: string, private_key: string) {
  if (!client_email) {
    console.error("❌ Missing client_email in service account credentials.");
    console.error("");
    process.exit(1);
  }

  if (!private_key) {
    console.error("❌ Missing private_key in service account credentials.");
    console.error("");
    process.exit(1);
  }

  const jwtClient = new google.auth.JWT(
    client_email,
    undefined,
    private_key,
    ["https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/indexing"],
    undefined
  );

  const tokens = await jwtClient.authorize();
  if (!tokens.access_token) {
    throw new Error("Failed to retrieve access token.");
  }
  return tokens.access_token;
}
