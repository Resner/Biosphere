import { expect, test } from '@playwright/test';

test('shows the title and the build label', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Biosphere' })).toBeVisible();
  await expect(page.getByTestId('build-label')).toHaveText(process.env.BUILD_LABEL || 'dev');
});

test('renders the WebGL scene', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('./');
  const canvas = page.locator('#scene');
  // Wait until a few frames have been drawn.
  await expect(canvas).toHaveAttribute('data-frames', /^([3-9]|\d{2,})$/);

  // Decode the screenshot in the page and count bright pixels: the cell's rim light and the
  // particles must be there, so the frame can't be a blank clear colour.
  const png = await canvas.screenshot();
  const stats = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const scratch = document.createElement('canvas');
    scratch.width = image.width;
    scratch.height = image.height;
    const context = scratch.getContext('2d');
    if (!context) throw new Error('2D canvas unavailable');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, scratch.width, scratch.height);
    let bright = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r = 0, g = 0, b = 0] = data.subarray(i, i + 3);
      if (0.2126 * r + 0.7152 * g + 0.0722 * b > 80) bright += 1;
    }
    return { bright, total: data.length / 4 };
  }, png.toString('base64'));

  expect(stats.bright / stats.total).toBeGreaterThan(0.002);
  expect(errors).toEqual([]);
});
