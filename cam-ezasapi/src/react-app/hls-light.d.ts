// The light build drops subtitles, alternate audio and EME — none of which a
// camera wall uses — and saves ~40% of the bundle. Its API is the default one.
declare module "hls.js/light" {
	export * from "hls.js";
	export { default } from "hls.js";
}
