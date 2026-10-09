// The artist's paths from an SVG file, without its outer <svg> element. Shared by
// the app icon generator and the startup screen, so both use the same artwork.
export function svgArtwork(source) {
  return source.replace(/^[\s\S]*?<svg\b[^>]*>/, "").replace(/<\/svg>\s*$/, "").trim();
}
