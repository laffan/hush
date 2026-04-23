/* Vite's `?url` asset import resolves to a string URL at build /
 * dev-server time. Declare it so TS accepts the imports in
 * brush-urls.ts. */
declare module "*.png?url" {
  const url: string;
  export default url;
}
