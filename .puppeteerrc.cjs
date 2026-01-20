const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
    // Changes the cache location for Puppeteer.
    // We use a directory inside the project root so it persists on Render between build and run.
    cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
