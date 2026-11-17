// SPDX-License-Identifier: AGPL-3.0-or-later
// ------------------------------------------------------------------
// GENERATED FILE -- do not edit by hand.
// Regenerate with: node scripts/gen-map-icons.cjs
// Source: lucide-react icon SVG nodes, ISC-licensed.
// ------------------------------------------------------------------

import { safeCssColor } from '@gratis-gis/shared-types';

/**
 * Map point-symbol icon registry (#73). Each entry is a
 * lucide-react glyph extracted to its raw SVG body. The picker
 * grid + the MapLibre image-registration step both consume this
 * registry; adding an icon means running gen-map-icons.cjs
 * with a fresh entry in the script's ICONS map.
 *
 * Icons share lucide's 24x24 viewBox, 2px stroke, rounded caps
 * conventions. The canvas rasterizer scales them to 48x48 PNG
 * when registering with MapLibre.
 */

export interface MapIcon {
  label: string;
  category: string;
  /** Inner SVG markup (without the surrounding <svg> element). */
  body: string;
}

export const MAP_ICONS: Record<string, MapIcon> = {
  "map-pin": {
    label: "Map pin",
    category: "markers",
    body: "<path d=\"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0\"/><circle cx=\"12\" cy=\"10\" r=\"3\"/>",
  },
  "star": {
    label: "Star",
    category: "markers",
    body: "<path d=\"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z\"/>",
  },
  "flag": {
    label: "Flag",
    category: "markers",
    body: "<path d=\"M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528\"/>",
  },
  "heart": {
    label: "Heart",
    category: "markers",
    body: "<path d=\"M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5\"/>",
  },
  "circle": {
    label: "Circle",
    category: "markers",
    body: "<circle cx=\"12\" cy=\"12\" r=\"10\"/>",
  },
  "square": {
    label: "Square",
    category: "markers",
    body: "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/>",
  },
  "triangle": {
    label: "Triangle",
    category: "markers",
    body: "<path d=\"M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z\"/>",
  },
  "hexagon": {
    label: "Hexagon",
    category: "markers",
    body: "<path d=\"M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z\"/>",
  },
  "octagon": {
    label: "Octagon",
    category: "markers",
    body: "<path d=\"M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z\"/>",
  },
  "pentagon": {
    label: "Pentagon",
    category: "markers",
    body: "<path d=\"M10.83 2.38a2 2 0 0 1 2.34 0l8 5.74a2 2 0 0 1 .73 2.25l-3.04 9.26a2 2 0 0 1-1.9 1.37H7.04a2 2 0 0 1-1.9-1.37L2.1 10.37a2 2 0 0 1 .73-2.25z\"/>",
  },
  "diamond": {
    label: "Diamond",
    category: "markers",
    body: "<path d=\"M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z\"/>",
  },
  "crosshair": {
    label: "Crosshair",
    category: "markers",
    body: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><line x1=\"22\" x2=\"18\" y1=\"12\" y2=\"12\"/><line x1=\"6\" x2=\"2\" y1=\"12\" y2=\"12\"/><line x1=\"12\" x2=\"12\" y1=\"6\" y2=\"2\"/><line x1=\"12\" x2=\"12\" y1=\"22\" y2=\"18\"/>",
  },
  "target": {
    label: "Target",
    category: "markers",
    body: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><circle cx=\"12\" cy=\"12\" r=\"6\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/>",
  },
  "bookmark": {
    label: "Bookmark",
    category: "markers",
    body: "<path d=\"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z\"/>",
  },
  "award": {
    label: "Award",
    category: "markers",
    body: "<path d=\"m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526\"/><circle cx=\"12\" cy=\"8\" r=\"6\"/>",
  },
  "home": {
    label: "Home",
    category: "buildings",
    body: "<path d=\"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8\"/><path d=\"M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/>",
  },
  "building": {
    label: "Building",
    category: "buildings",
    body: "<path d=\"M12 10h.01\"/><path d=\"M12 14h.01\"/><path d=\"M12 6h.01\"/><path d=\"M16 10h.01\"/><path d=\"M16 14h.01\"/><path d=\"M16 6h.01\"/><path d=\"M8 10h.01\"/><path d=\"M8 14h.01\"/><path d=\"M8 6h.01\"/><path d=\"M9 22v-3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3\"/><rect x=\"4\" y=\"2\" width=\"16\" height=\"20\" rx=\"2\"/>",
  },
  "building-2": {
    label: "Office",
    category: "buildings",
    body: "<path d=\"M10 12h4\"/><path d=\"M10 8h4\"/><path d=\"M14 21v-3a2 2 0 0 0-4 0v3\"/><path d=\"M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2\"/><path d=\"M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16\"/>",
  },
  "hospital": {
    label: "Hospital",
    category: "buildings",
    body: "<path d=\"M12 7v4\"/><path d=\"M14 21v-3a2 2 0 0 0-4 0v3\"/><path d=\"M14 9h-4\"/><path d=\"M18 11h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h2\"/><path d=\"M18 21V5a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16\"/>",
  },
  "school": {
    label: "School",
    category: "buildings",
    body: "<path d=\"M14 21v-3a2 2 0 0 0-4 0v3\"/><path d=\"M18 4.933V21\"/><path d=\"m4 6 7.106-3.79a2 2 0 0 1 1.788 0L20 6\"/><path d=\"m6 11-3.52 2.147a1 1 0 0 0-.48.854V19a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a1 1 0 0 0-.48-.853L18 11\"/><path d=\"M6 4.933V21\"/><circle cx=\"12\" cy=\"9\" r=\"2\"/>",
  },
  "university": {
    label: "University",
    category: "buildings",
    body: "<path d=\"M14 21v-3a2 2 0 0 0-4 0v3\"/><path d=\"M18 12h.01\"/><path d=\"M18 16h.01\"/><path d=\"M22 7a1 1 0 0 0-1-1h-2a2 2 0 0 1-1.143-.359L13.143 2.36a2 2 0 0 0-2.286-.001L6.143 5.64A2 2 0 0 1 5 6H3a1 1 0 0 0-1 1v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2z\"/><path d=\"M6 12h.01\"/><path d=\"M6 16h.01\"/><circle cx=\"12\" cy=\"10\" r=\"2\"/>",
  },
  "warehouse": {
    label: "Warehouse",
    category: "buildings",
    body: "<path d=\"M18 21V10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v11\"/><path d=\"M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 1.132-1.803l7.95-3.974a2 2 0 0 1 1.837 0l7.948 3.974A2 2 0 0 1 22 8z\"/><path d=\"M6 13h12\"/><path d=\"M6 17h12\"/>",
  },
  "factory": {
    label: "Factory",
    category: "buildings",
    body: "<path d=\"M12 16h.01\"/><path d=\"M16 16h.01\"/><path d=\"M3 19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5a.5.5 0 0 0-.769-.422l-4.462 2.844A.5.5 0 0 1 15 10.5v-2a.5.5 0 0 0-.769-.422L9.77 10.922A.5.5 0 0 1 9 10.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z\"/><path d=\"M8 16h.01\"/>",
  },
  "church": {
    label: "Church",
    category: "buildings",
    body: "<path d=\"M10 9h4\"/><path d=\"M12 7v5\"/><path d=\"M14 21v-3a2 2 0 0 0-4 0v3\"/><path d=\"m18 9 3.52 2.147a1 1 0 0 1 .48.854V19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6.999a1 1 0 0 1 .48-.854L6 9\"/><path d=\"M6 21V7a1 1 0 0 1 .376-.782l5-3.999a1 1 0 0 1 1.249.001l5 4A1 1 0 0 1 18 7v14\"/>",
  },
  "store": {
    label: "Store",
    category: "buildings",
    body: "<path d=\"M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5\"/><path d=\"M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244\"/><path d=\"M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05\"/>",
  },
  "hotel": {
    label: "Hotel",
    category: "buildings",
    body: "<path d=\"M10 22v-6.57\"/><path d=\"M12 11h.01\"/><path d=\"M12 7h.01\"/><path d=\"M14 15.43V22\"/><path d=\"M15 16a5 5 0 0 0-6 0\"/><path d=\"M16 11h.01\"/><path d=\"M16 7h.01\"/><path d=\"M8 11h.01\"/><path d=\"M8 7h.01\"/><rect x=\"4\" y=\"2\" width=\"16\" height=\"20\" rx=\"2\"/>",
  },
  "landmark": {
    label: "Landmark",
    category: "buildings",
    body: "<path d=\"M10 18v-7\"/><path d=\"M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z\"/><path d=\"M14 18v-7\"/><path d=\"M18 18v-7\"/><path d=\"M3 22h18\"/><path d=\"M6 18v-7\"/>",
  },
  "castle": {
    label: "Castle",
    category: "buildings",
    body: "<path d=\"M10 5V3\"/><path d=\"M14 5V3\"/><path d=\"M15 21v-3a3 3 0 0 0-6 0v3\"/><path d=\"M18 3v8\"/><path d=\"M18 5H6\"/><path d=\"M22 11H2\"/><path d=\"M22 9v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9\"/><path d=\"M6 3v8\"/>",
  },
  "tent": {
    label: "Tent",
    category: "buildings",
    body: "<path d=\"M3.5 21 14 3\"/><path d=\"M20.5 21 10 3\"/><path d=\"M15.5 21 12 15l-3.5 6\"/><path d=\"M2 21h20\"/>",
  },
  "shield": {
    label: "Shield",
    category: "public-safety",
    body: "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"/>",
  },
  "shield-check": {
    label: "Shield (check)",
    category: "public-safety",
    body: "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"/><path d=\"m9 12 2 2 4-4\"/>",
  },
  "shield-alert": {
    label: "Shield (alert)",
    category: "public-safety",
    body: "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"/><path d=\"M12 8v4\"/><path d=\"M12 16h.01\"/>",
  },
  "badge": {
    label: "Badge",
    category: "public-safety",
    body: "<path d=\"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z\"/>",
  },
  "siren": {
    label: "Siren",
    category: "public-safety",
    body: "<path d=\"M7 18v-6a5 5 0 1 1 10 0v6\"/><path d=\"M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z\"/><path d=\"M21 12h1\"/><path d=\"M18.5 4.5 18 5\"/><path d=\"M2 12h1\"/><path d=\"M12 2v1\"/><path d=\"m4.929 4.929.707.707\"/><path d=\"M12 12v6\"/>",
  },
  "alert-triangle": {
    label: "Alert (triangle)",
    category: "public-safety",
    body: "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"/><path d=\"M12 9v4\"/><path d=\"M12 17h.01\"/>",
  },
  "alert-octagon": {
    label: "Alert (octagon)",
    category: "public-safety",
    body: "<path d=\"M12 16h.01\"/><path d=\"M12 8v4\"/><path d=\"M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z\"/>",
  },
  "alert-circle": {
    label: "Alert (circle)",
    category: "public-safety",
    body: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><line x1=\"12\" x2=\"12\" y1=\"8\" y2=\"12\"/><line x1=\"12\" x2=\"12.01\" y1=\"16\" y2=\"16\"/>",
  },
  "ban": {
    label: "Prohibited",
    category: "public-safety",
    body: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M4.929 4.929 19.07 19.071\"/>",
  },
  "scale": {
    label: "Scales of justice",
    category: "public-safety",
    body: "<path d=\"M12 3v18\"/><path d=\"m19 8 3 8a5 5 0 0 1-6 0zV7\"/><path d=\"M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1\"/><path d=\"m5 8 3 8a5 5 0 0 1-6 0zV7\"/><path d=\"M7 21h10\"/>",
  },
  "gavel": {
    label: "Gavel",
    category: "public-safety",
    body: "<path d=\"m14 13-8.381 8.38a1 1 0 0 1-3.001-3l8.384-8.381\"/><path d=\"m16 16 6-6\"/><path d=\"m21.5 10.5-8-8\"/><path d=\"m8 8 6-6\"/><path d=\"m8.5 7.5 8 8\"/>",
  },
  "vote": {
    label: "Vote",
    category: "public-safety",
    body: "<path d=\"m9 12 2 2 4-4\"/><path d=\"M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5V7Z\"/><path d=\"M22 19H2\"/>",
  },
  "car": {
    label: "Car",
    category: "transportation",
    body: "<path d=\"M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2\"/><circle cx=\"7\" cy=\"17\" r=\"2\"/><path d=\"M9 17h6\"/><circle cx=\"17\" cy=\"17\" r=\"2\"/>",
  },
  "truck": {
    label: "Truck",
    category: "transportation",
    body: "<path d=\"M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2\"/><path d=\"M15 18H9\"/><path d=\"M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14\"/><circle cx=\"17\" cy=\"18\" r=\"2\"/><circle cx=\"7\" cy=\"18\" r=\"2\"/>",
  },
  "bus": {
    label: "Bus",
    category: "transportation",
    body: "<path d=\"M8 6v6\"/><path d=\"M15 6v6\"/><path d=\"M2 12h19.6\"/><path d=\"M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3\"/><circle cx=\"7\" cy=\"18\" r=\"2\"/><path d=\"M9 18h5\"/><circle cx=\"16\" cy=\"18\" r=\"2\"/>",
  },
  "train-front": {
    label: "Train",
    category: "transportation",
    body: "<path d=\"M8 3.1V7a4 4 0 0 0 8 0V3.1\"/><path d=\"m9 15-1-1\"/><path d=\"m15 15 1-1\"/><path d=\"M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z\"/><path d=\"m8 19-2 3\"/><path d=\"m16 19 2 3\"/>",
  },
  "train-track": {
    label: "Train track",
    category: "transportation",
    body: "<path d=\"M2 17 17 2\"/><path d=\"m2 14 8 8\"/><path d=\"m5 11 8 8\"/><path d=\"m8 8 8 8\"/><path d=\"m11 5 8 8\"/><path d=\"m14 2 8 8\"/><path d=\"M7 22 22 7\"/>",
  },
  "plane": {
    label: "Plane",
    category: "transportation",
    body: "<path d=\"M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z\"/>",
  },
  "ship": {
    label: "Ship",
    category: "transportation",
    body: "<path d=\"M12 2v2\"/><path d=\"M12 9.189V13\"/><path d=\"M19 12V6a2 2 0 00-2-2H7a2 2 0 00-2 2v6\"/><path d=\"M19.38 19A11.6 11.6 0 0021 13l-8.188-3.639a2 2 0 00-1.624 0L3 13.001a11.6 11.6 0 002.81 7.76\"/><path d=\"M2 20c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1\"/>",
  },
  "bike": {
    label: "Bike",
    category: "transportation",
    body: "<circle cx=\"18.5\" cy=\"17.5\" r=\"3.5\"/><circle cx=\"5.5\" cy=\"17.5\" r=\"3.5\"/><circle cx=\"15\" cy=\"5\" r=\"1\"/><path d=\"M12 17.5V14l-3-3 4-3 2 3h2\"/>",
  },
  "tram-front": {
    label: "Tram",
    category: "transportation",
    body: "<rect width=\"16\" height=\"16\" x=\"4\" y=\"3\" rx=\"2\"/><path d=\"M4 11h16\"/><path d=\"M12 3v8\"/><path d=\"m8 19-2 3\"/><path d=\"m18 22-2-3\"/><path d=\"M8 15h.01\"/><path d=\"M16 15h.01\"/>",
  },
  "caravan": {
    label: "Caravan",
    category: "transportation",
    body: "<path d=\"M18 19V9a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v8a2 2 0 0 0 2 2h2\"/><path d=\"M2 9h3a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H2\"/><path d=\"M22 17v1a1 1 0 0 1-1 1H10v-9a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v9\"/><circle cx=\"8\" cy=\"19\" r=\"2\"/>",
  },
  "navigation": {
    label: "Navigation",
    category: "transportation",
    body: "<polygon points=\"3 11 22 2 13 21 11 13 3 11\"/>",
  },
  "route": {
    label: "Route",
    category: "transportation",
    body: "<path d=\"M9 5h8.5a1 1 0 010 7h-11a1 1 0 000 7H15\"/><circle cx=\"18\" cy=\"19\" r=\"3\"/><circle cx=\"6\" cy=\"5\" r=\"3\"/>",
  },
  "anchor": {
    label: "Anchor",
    category: "transportation",
    body: "<path d=\"M12 6v16\"/><path d=\"m19 13 2-1a9 9 0 0 1-18 0l2 1\"/><path d=\"M9 11h6\"/><circle cx=\"12\" cy=\"4\" r=\"2\"/>",
  },
  "square-parking": {
    label: "Parking",
    category: "transportation",
    body: "<path d=\"M9 12h4a2 2 0 0 0 0-4H9.5a.5.5 0 0 0-.5.5V16\"/><rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/>",
  },
  "traffic-cone": {
    label: "Traffic cone",
    category: "transportation",
    body: "<path d=\"M16.05 10.966a5 2.5 0 0 1-8.1 0\"/><path d=\"m16.923 14.049 4.48 2.04a1 1 0 0 1 .001 1.831l-8.574 3.9a2 2 0 0 1-1.66 0l-8.574-3.91a1 1 0 0 1 0-1.83l4.484-2.04\"/><path d=\"M16.949 14.14a5 2.5 0 1 1-9.9 0L10.063 3.5a2 2 0 0 1 3.874 0z\"/><path d=\"M9.194 6.57a5 2.5 0 0 0 5.61 0\"/>",
  },
  "tree-deciduous": {
    label: "Tree",
    category: "nature",
    body: "<path d=\"M8 19a4 4 0 0 1-2.24-7.32A3.5 3.5 0 0 1 9 6.03V6a3 3 0 1 1 6 0v.04a3.5 3.5 0 0 1 3.24 5.65A4 4 0 0 1 16 19Z\"/><path d=\"M12 19v3\"/>",
  },
  "tree-pine": {
    label: "Pine tree",
    category: "nature",
    body: "<path d=\"m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z\"/><path d=\"M12 22v-3\"/>",
  },
  "trees": {
    label: "Forest",
    category: "nature",
    body: "<path d=\"M10 10v.2A3 3 0 0 1 8.9 16H5a3 3 0 0 1-1-5.8V10a3 3 0 0 1 6 0Z\"/><path d=\"M7 16v6\"/><path d=\"M13 19v3\"/><path d=\"M12 19h8.3a1 1 0 0 0 .7-1.7L18 14h.3a1 1 0 0 0 .7-1.7L16 9h.2a1 1 0 0 0 .8-1.7L13 3l-1.4 1.5\"/>",
  },
  "mountain": {
    label: "Mountain",
    category: "nature",
    body: "<path d=\"m8 3 4 8 5-5 5 15H2L8 3z\"/>",
  },
  "mountain-snow": {
    label: "Snowy mountain",
    category: "nature",
    body: "<path d=\"m8 3 4 8 5-5 5 15H2L8 3z\"/><path d=\"M4.14 15.08c2.62-1.57 5.24-1.43 7.86.42 2.74 1.94 5.49 2 8.23.19\"/>",
  },
  "waves": {
    label: "Waves",
    category: "nature",
    body: "<path d=\"M2 12q2.5 2 5 0t5 0 5 0 5 0\"/><path d=\"M2 19q2.5 2 5 0t5 0 5 0 5 0\"/><path d=\"M2 5q2.5 2 5 0t5 0 5 0 5 0\"/>",
  },
  "droplet": {
    label: "Droplet",
    category: "nature",
    body: "<path d=\"M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z\"/>",
  },
  "cloud": {
    label: "Cloud",
    category: "nature",
    body: "<path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\"/>",
  },
  "cloud-rain": {
    label: "Rain",
    category: "nature",
    body: "<path d=\"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242\"/><path d=\"M16 14v6\"/><path d=\"M8 14v6\"/><path d=\"M12 16v6\"/>",
  },
  "cloud-snow": {
    label: "Snow",
    category: "nature",
    body: "<path d=\"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242\"/><path d=\"M8 15h.01\"/><path d=\"M8 19h.01\"/><path d=\"M12 17h.01\"/><path d=\"M12 21h.01\"/><path d=\"M16 15h.01\"/><path d=\"M16 19h.01\"/>",
  },
  "snowflake": {
    label: "Snowflake",
    category: "nature",
    body: "<path d=\"m10 20-1.25-2.5L6 18\"/><path d=\"M10 4 8.75 6.5 6 6\"/><path d=\"m14 20 1.25-2.5L18 18\"/><path d=\"m14 4 1.25 2.5L18 6\"/><path d=\"m17 21-3-6h-4\"/><path d=\"m17 3-3 6 1.5 3\"/><path d=\"M2 12h6.5L10 9\"/><path d=\"m20 10-1.5 2 1.5 2\"/><path d=\"M22 12h-6.5L14 15\"/><path d=\"m4 10 1.5 2L4 14\"/><path d=\"m7 21 3-6-1.5-3\"/><path d=\"m7 3 3 6h4\"/>",
  },
  "sun": {
    label: "Sun",
    category: "nature",
    body: "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2\"/><path d=\"M12 20v2\"/><path d=\"m4.93 4.93 1.41 1.41\"/><path d=\"m17.66 17.66 1.41 1.41\"/><path d=\"M2 12h2\"/><path d=\"M20 12h2\"/><path d=\"m6.34 17.66-1.41 1.41\"/><path d=\"m19.07 4.93-1.41 1.41\"/>",
  },
  "moon": {
    label: "Moon",
    category: "nature",
    body: "<path d=\"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401\"/>",
  },
  "wind": {
    label: "Wind",
    category: "nature",
    body: "<path d=\"M12.8 19.6A2 2 0 1 0 14 16H2\"/><path d=\"M17.5 8a2.5 2.5 0 1 1 2 4H2\"/><path d=\"M9.8 4.4A2 2 0 1 1 11 8H2\"/>",
  },
  "flame": {
    label: "Flame",
    category: "nature",
    body: "<path d=\"M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4\"/>",
  },
  "leaf": {
    label: "Leaf",
    category: "nature",
    body: "<path d=\"M11 20a10 10 0 0010-10 25.9 25.9 0 00-1.04-7.281 1 1 0 00-1.755-.325C15.833 5.5 13 5.5 9.8 6.1A7 7 0 0011 20\"/><path d=\"M2 21a5 5 0 012.911-4.544C7.613 15.212 8.351 15.24 11 13\"/>",
  },
  "sprout": {
    label: "Sprout",
    category: "nature",
    body: "<path d=\"M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3\"/><path d=\"M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4\"/><path d=\"M5 21h14\"/>",
  },
  "flower": {
    label: "Flower",
    category: "nature",
    body: "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 16.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 1 1 4.5 4.5 4.5 4.5 0 1 1-4.5 4.5\"/><path d=\"M12 7.5V9\"/><path d=\"M7.5 12H9\"/><path d=\"M16.5 12H15\"/><path d=\"M12 16.5V15\"/><path d=\"m8 8 1.88 1.88\"/><path d=\"M14.12 9.88 16 8\"/><path d=\"m8 16 1.88-1.88\"/><path d=\"M14.12 14.12 16 16\"/>",
  },
  "bug": {
    label: "Bug",
    category: "nature",
    body: "<path d=\"M12 20v-9\"/><path d=\"M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z\"/><path d=\"M14.12 3.88 16 2\"/><path d=\"M21 21a4 4 0 0 0-3.81-4\"/><path d=\"M21 5a4 4 0 0 1-3.55 3.97\"/><path d=\"M22 13h-4\"/><path d=\"M3 21a4 4 0 0 1 3.81-4\"/><path d=\"M3 5a4 4 0 0 0 3.55 3.97\"/><path d=\"M6 13H2\"/><path d=\"m8 2 1.88 1.88\"/><path d=\"M9 7.13V6a3 3 0 1 1 6 0v1.13\"/>",
  },
  "fish": {
    label: "Fish",
    category: "nature",
    body: "<path d=\"M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z\"/><path d=\"M18 12v.5\"/><path d=\"M16 17.93a9.77 9.77 0 0 1 0-11.86\"/><path d=\"M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33\"/><path d=\"M10.46 7.26C10.2 5.88 9.17 4.24 8 3h5.8a2 2 0 0 1 1.98 1.67l.23 1.4\"/><path d=\"m16.01 17.93-.23 1.4A2 2 0 0 1 13.8 21H9.5a5.96 5.96 0 0 0 1.49-3.98\"/>",
  },
  "bird": {
    label: "Bird",
    category: "nature",
    body: "<path d=\"M16 7h.01\"/><path d=\"M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20\"/><path d=\"m20 7 2 .5-2 .5\"/><path d=\"M10 18v3\"/><path d=\"M14 17.75V21\"/><path d=\"M7 18a6 6 0 0 0 3.84-10.61\"/>",
  },
  "rabbit": {
    label: "Rabbit",
    category: "nature",
    body: "<path d=\"M13 16a3 3 0 0 1 2.24 5\"/><path d=\"M18 12h.01\"/><path d=\"M18 21h-8a4 4 0 0 1-4-4 7 7 0 0 1 7-7h.2L9.6 6.4a1 1 0 1 1 2.8-2.8L15.8 7h.2c3.3 0 6 2.7 6 6v1a2 2 0 0 1-2 2h-1a3 3 0 0 0-3 3\"/><path d=\"M20 8.54V4a2 2 0 1 0-4 0v3\"/><path d=\"M7.612 12.524a3 3 0 1 0-1.6 4.3\"/>",
  },
  "power": {
    label: "Power",
    category: "utilities",
    body: "<path d=\"M12 2v10\"/><path d=\"M18.4 6.6a9 9 0 1 1-12.77.04\"/>",
  },
  "fuel": {
    label: "Fuel",
    category: "utilities",
    body: "<path d=\"M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0v-6.998a2 2 0 0 0-.59-1.42L18 5\"/><path d=\"M14 21V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v16\"/><path d=\"M2 21h13\"/><path d=\"M3 9h11\"/>",
  },
  "plug-zap": {
    label: "Plug",
    category: "utilities",
    body: "<path d=\"M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z\"/><path d=\"m2 22 3-3\"/><path d=\"M7.5 13.5 10 11\"/><path d=\"M10.5 16.5 13 14\"/><path d=\"m18 3-4 4h6l-4 4\"/>",
  },
  "zap": {
    label: "Lightning",
    category: "utilities",
    body: "<path d=\"M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z\"/>",
  },
  "lightbulb": {
    label: "Lightbulb",
    category: "utilities",
    body: "<path d=\"M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5\"/><path d=\"M9 18h6\"/><path d=\"M10 22h4\"/>",
  },
  "antenna": {
    label: "Antenna",
    category: "utilities",
    body: "<path d=\"M2 12 7 2\"/><path d=\"m7 12 5-10\"/><path d=\"m12 12 5-10\"/><path d=\"m17 12 5-10\"/><path d=\"M4.5 7h15\"/><path d=\"M12 16v6\"/>",
  },
  "wifi": {
    label: "Wi-Fi",
    category: "utilities",
    body: "<path d=\"M12 20h.01\"/><path d=\"M2 8.82a15 15 0 0 1 20 0\"/><path d=\"M5 12.859a10 10 0 0 1 14 0\"/><path d=\"M8.5 16.429a5 5 0 0 1 7 0\"/>",
  },
  "signal": {
    label: "Signal",
    category: "utilities",
    body: "<path d=\"M2 20h.01\"/><path d=\"M7 20v-4\"/><path d=\"M12 20v-8\"/><path d=\"M17 20V8\"/><path d=\"M22 4v16\"/>",
  },
  "radio": {
    label: "Radio",
    category: "utilities",
    body: "<path d=\"M16.247 7.761a6 6 0 0 1 0 8.478\"/><path d=\"M19.075 4.933a10 10 0 0 1 0 14.134\"/><path d=\"M4.925 19.067a10 10 0 0 1 0-14.134\"/><path d=\"M7.753 16.239a6 6 0 0 1 0-8.478\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/>",
  },
  "satellite-dish": {
    label: "Satellite dish",
    category: "utilities",
    body: "<path d=\"M18 12a6 6 0 00-6-6\"/><path d=\"M2.824 10.459a8 8 0 0010.717 10.717c.558-.276.623-1.012.183-1.452l-9.448-9.448c-.44-.44-1.176-.375-1.452.183\"/><path d=\"M22 12A10 10 0 0012 2\"/><path d=\"m9 15 4-4\"/>",
  },
  "satellite": {
    label: "Satellite",
    category: "utilities",
    body: "<path d=\"m13.5 6.5-3.148-3.148a1.205 1.205 0 0 0-1.704 0L6.352 5.648a1.205 1.205 0 0 0 0 1.704L9.5 10.5\"/><path d=\"M16.5 7.5 19 5\"/><path d=\"m17.5 10.5 3.148 3.148a1.205 1.205 0 0 1 0 1.704l-2.296 2.296a1.205 1.205 0 0 1-1.704 0L13.5 14.5\"/><path d=\"M9 21a6 6 0 0 0-6-6\"/><path d=\"M9.352 10.648a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l4.296-4.296a1.205 1.205 0 0 0 0-1.704l-2.296-2.296a1.205 1.205 0 0 0-1.704 0z\"/>",
  },
  "battery": {
    label: "Battery",
    category: "utilities",
    body: "<path d=\"M 22 14 L 22 10\"/><rect x=\"2\" y=\"6\" width=\"16\" height=\"12\" rx=\"2\"/>",
  },
  "recycle": {
    label: "Recycle",
    category: "utilities",
    body: "<path d=\"M7 19H4.815a1.83 1.83 0 0 1-1.57-.881 1.785 1.785 0 0 1-.004-1.784L7.196 9.5\"/><path d=\"M11 19h8.203a1.83 1.83 0 0 0 1.556-.89 1.784 1.784 0 0 0 0-1.775l-1.226-2.12\"/><path d=\"m14 16-3 3 3 3\"/><path d=\"M8.293 13.596 7.196 9.5 3.1 10.598\"/><path d=\"m9.344 5.811 1.093-1.892A1.83 1.83 0 0 1 11.985 3a1.784 1.784 0 0 1 1.546.888l3.943 6.843\"/><path d=\"m13.378 9.633 4.096 1.098 1.097-4.096\"/>",
  },
  "trash": {
    label: "Trash",
    category: "utilities",
    body: "<path d=\"M10 11v6\"/><path d=\"M14 11v6\"/><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"/><path d=\"M3 6h18\"/><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/>",
  },
  "pipette": {
    label: "Pipette",
    category: "utilities",
    body: "<path d=\"m12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12\"/><path d=\"m18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z\"/><path d=\"m2 22 .414-.414\"/>",
  },
  "coffee": {
    label: "Coffee",
    category: "services",
    body: "<path d=\"M10 2v2\"/><path d=\"M14 2v2\"/><path d=\"M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1\"/><path d=\"M6 2v2\"/>",
  },
  "utensils": {
    label: "Restaurant",
    category: "services",
    body: "<path d=\"M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2\"/><path d=\"M7 2v20\"/><path d=\"M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7\"/>",
  },
  "shopping-cart": {
    label: "Shopping cart",
    category: "services",
    body: "<path d=\"m2.05 2.05 1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18\"/><path d=\"M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25\"/><circle cx=\"18\" cy=\"20\" r=\"2\"/><circle cx=\"8\" cy=\"20\" r=\"2\"/>",
  },
  "shopping-bag": {
    label: "Shopping bag",
    category: "services",
    body: "<path d=\"M16 10a4 4 0 0 1-8 0\"/><path d=\"M3.103 6.034h17.794\"/><path d=\"M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z\"/>",
  },
  "bed": {
    label: "Bed",
    category: "services",
    body: "<path d=\"M2 4v16\"/><path d=\"M2 8h18a2 2 0 0 1 2 2v10\"/><path d=\"M2 17h20\"/><path d=\"M6 8v9\"/>",
  },
  "baby": {
    label: "Baby",
    category: "services",
    body: "<path d=\"M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5\"/><path d=\"M15 12h.01\"/><path d=\"M19.38 6.813A9 9 0 0 1 20.8 10.2a2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5 1.1 3.5 2.5s-.9 2.5-2 2.5c-.8 0-1.5-.4-1.5-1\"/><path d=\"M9 12h.01\"/>",
  },
  "ticket": {
    label: "Ticket",
    category: "services",
    body: "<path d=\"M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z\"/><path d=\"M13 5v2\"/><path d=\"M13 17v2\"/><path d=\"M13 11v2\"/>",
  },
  "music": {
    label: "Music",
    category: "services",
    body: "<path d=\"M21 16V3a1 1 0 0 0-1.28-.96l-10 2.917a1 1 0 0 0-.72.96V19\"/><circle cx=\"18\" cy=\"16\" r=\"3\"/><circle cx=\"6\" cy=\"19\" r=\"3\"/>",
  },
  "film": {
    label: "Film",
    category: "services",
    body: "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/><path d=\"M7 3v18\"/><path d=\"M3 7.5h4\"/><path d=\"M3 12h18\"/><path d=\"M3 16.5h4\"/><path d=\"M17 3v18\"/><path d=\"M17 7.5h4\"/><path d=\"M17 16.5h4\"/>",
  },
  "popcorn": {
    label: "Popcorn",
    category: "services",
    body: "<path d=\"M18 8a2 2 0 0 0 0-4 2 2 0 0 0-4 0 2 2 0 0 0-4 0 2 2 0 0 0-4 0 2 2 0 0 0 0 4\"/><path d=\"M10 22 9 8\"/><path d=\"m14 22 1-14\"/><path d=\"M20 8c.5 0 .9.4.8 1l-2.6 12c-.1.5-.7 1-1.2 1H7c-.6 0-1.1-.4-1.2-1L3.2 9c-.1-.6.3-1 .8-1Z\"/>",
  },
  "ferris-wheel": {
    label: "Amusement",
    category: "services",
    body: "<circle cx=\"12\" cy=\"12\" r=\"2\"/><path d=\"M12 2v4\"/><path d=\"m6.8 15-3.5 2\"/><path d=\"m20.7 7-3.5 2\"/><path d=\"M6.8 9 3.3 7\"/><path d=\"m20.7 17-3.5-2\"/><path d=\"m9 22 3-8 3 8\"/><path d=\"M8 22h8\"/><path d=\"M18 18.7a9 9 0 1 0-12 0\"/>",
  },
  "dumbbell": {
    label: "Gym",
    category: "services",
    body: "<path d=\"M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829z\"/><path d=\"m2.5 21.5 1.4-1.4\"/><path d=\"m20.1 3.9 1.4-1.4\"/><path d=\"M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829z\"/><path d=\"m9.6 14.4 4.8-4.8\"/>",
  },
  "scissors": {
    label: "Salon",
    category: "services",
    body: "<circle cx=\"6\" cy=\"6\" r=\"3\"/><path d=\"M8.12 8.12 12 12\"/><path d=\"M20 4 8.12 15.88\"/><circle cx=\"6\" cy=\"18\" r=\"3\"/><path d=\"M14.8 14.8 20 20\"/>",
  },
  "stethoscope": {
    label: "Medical",
    category: "services",
    body: "<path d=\"M11 2v2\"/><path d=\"M5 2v2\"/><path d=\"M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1\"/><path d=\"M8 15a6 6 0 0 0 12 0v-3\"/><circle cx=\"20\" cy=\"10\" r=\"2\"/>",
  },
  "pill": {
    label: "Pharmacy",
    category: "services",
    body: "<path d=\"m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z\"/><path d=\"m8.5 8.5 7 7\"/>",
  },
  "syringe": {
    label: "Vaccine",
    category: "services",
    body: "<path d=\"m18 2 4 4\"/><path d=\"m17 7 3-3\"/><path d=\"M19 9 8.7 19.3c-1 1-2.5 1-3.4 0l-.6-.6c-1-1-1-2.5 0-3.4L15 5\"/><path d=\"m9 11 4 4\"/><path d=\"m5 19-3 3\"/><path d=\"m14 4 6 6\"/>",
  },
  "phone": {
    label: "Phone",
    category: "communication",
    body: "<path d=\"M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384\"/>",
  },
  "phone-call": {
    label: "Call",
    category: "communication",
    body: "<path d=\"M13 2a9 9 0 0 1 9 9\"/><path d=\"M13 6a5 5 0 0 1 5 5\"/><path d=\"M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384\"/>",
  },
  "message-circle": {
    label: "Message",
    category: "communication",
    body: "<path d=\"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719\"/>",
  },
  "mail": {
    label: "Mail",
    category: "communication",
    body: "<path d=\"m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7\"/><rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\"/>",
  },
  "megaphone": {
    label: "Megaphone",
    category: "communication",
    body: "<path d=\"M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z\"/><path d=\"M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14\"/><path d=\"M8 6v8\"/>",
  },
  "info": {
    label: "Info",
    category: "communication",
    body: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 16v-4\"/><path d=\"M12 8h.01\"/>",
  },
  "help-circle": {
    label: "Help",
    category: "communication",
    body: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M9 9.5a3 2.5 0 016 0c0 2-2 2-3 3.5\"/><path d=\"M12 17h.01\"/>",
  },
  "globe": {
    label: "Globe",
    category: "communication",
    body: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\"/><path d=\"M2 12h20\"/>",
  },
  "user": {
    label: "User",
    category: "people",
    body: "<path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/>",
  },
  "users": {
    label: "Group",
    category: "people",
    body: "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><path d=\"M16 3.128a4 4 0 0 1 0 7.744\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/>",
  },
  "accessibility": {
    label: "Accessibility",
    category: "people",
    body: "<circle cx=\"16\" cy=\"4\" r=\"1\"/><path d=\"m18 19 1-7-6 1\"/><path d=\"m5 8 3-3 5.5 3-2.36 3.5\"/><path d=\"M4.24 14.5a5 5 0 0 0 6.88 6\"/><path d=\"M13.76 17.5a5 5 0 0 0-6.88-6\"/>",
  },
  "dog": {
    label: "Dog",
    category: "people",
    body: "<path d=\"M11.25 16.25h1.5L12 17z\"/><path d=\"M16 14v.5\"/><path d=\"M4.42 11.247A13.152 13.152 0 0 0 4 14.556C4 18.728 7.582 21 12 21s8-2.272 8-6.444a11.702 11.702 0 0 0-.493-3.309\"/><path d=\"M8 14v.5\"/><path d=\"M8.5 8.5c-.384 1.05-1.083 2.028-2.344 2.5-1.931.722-3.576-.297-3.656-1-.113-.994 1.177-6.53 4-7 1.923-.321 3.651.845 3.651 2.235A7.497 7.497 0 0 1 14 5.277c0-1.39 1.844-2.598 3.767-2.277 2.823.47 4.113 6.006 4 7-.08.703-1.725 1.722-3.656 1-1.261-.472-1.855-1.45-2.239-2.5\"/>",
  },
  "cat": {
    label: "Cat",
    category: "people",
    body: "<path d=\"M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-.42 7 .57 1.07 1 2.24 1 3.44C21 17.9 16.97 21 12 21s-9-3-9-7.56c0-1.25.5-2.4 1-3.44 0 0-1.89-6.42-.5-7 1.39-.58 4.72.23 6.5 2.23A9.04 9.04 0 0 1 12 5Z\"/><path d=\"M8 14v.5\"/><path d=\"M16 14v.5\"/><path d=\"M11.25 16.25h1.5L12 17l-.75-.75Z\"/>",
  },
  "microscope": {
    label: "Microscope",
    category: "science",
    body: "<path d=\"M6 18h8\"/><path d=\"M3 22h18\"/><path d=\"M14 22a7 7 0 1 0 0-14h-1\"/><path d=\"M9 14h2\"/><path d=\"M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z\"/><path d=\"M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3\"/>",
  },
  "flask-conical": {
    label: "Flask",
    category: "science",
    body: "<path d=\"M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2\"/><path d=\"M6.453 15h11.094\"/><path d=\"M8.5 2h7\"/>",
  },
  "flask-round": {
    label: "Beaker",
    category: "science",
    body: "<path d=\"M10 2v6.292a7 7 0 1 0 4 0V2\"/><path d=\"M5 15h14\"/><path d=\"M8.5 2h7\"/>",
  },
  "atom": {
    label: "Atom",
    category: "science",
    body: "<circle cx=\"12\" cy=\"12\" r=\"1\"/><path d=\"M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z\"/><path d=\"M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z\"/>",
  },
  "telescope": {
    label: "Telescope",
    category: "science",
    body: "<path d=\"m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44\"/><path d=\"m13.56 11.747 4.332-.924\"/><path d=\"m16 21-3.105-6.21\"/><path d=\"M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z\"/><path d=\"m6.158 8.633 1.114 4.456\"/><path d=\"m8 21 3.105-6.21\"/><circle cx=\"12\" cy=\"13\" r=\"2\"/>",
  },
  "book-open": {
    label: "Book",
    category: "science",
    body: "<path d=\"M12 5v16\"/><path d=\"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z\"/>",
  },
  "graduation-cap": {
    label: "Graduation",
    category: "science",
    body: "<path d=\"M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z\"/><path d=\"M22 10v6\"/><path d=\"M6 12.5V16a6 3 0 0 0 12 0v-3.5\"/>",
  },
  "camera": {
    label: "Camera",
    category: "tools",
    body: "<path d=\"M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z\"/><circle cx=\"12\" cy=\"13\" r=\"3\"/>",
  },
  "video": {
    label: "Video",
    category: "tools",
    body: "<path d=\"m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5\"/><rect x=\"2\" y=\"6\" width=\"14\" height=\"12\" rx=\"2\"/>",
  },
  "hard-hat": {
    label: "Construction",
    category: "tools",
    body: "<path d=\"M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5\"/><path d=\"M14 6a6 6 0 0 1 6 6v3\"/><path d=\"M4 15v-3a6 6 0 0 1 6-6\"/><rect x=\"2\" y=\"15\" width=\"20\" height=\"4\" rx=\"1\"/>",
  },
  "hammer": {
    label: "Hammer",
    category: "tools",
    body: "<path d=\"m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9\"/><path d=\"m18 15 4-4\"/><path d=\"m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5\"/>",
  },
  "wrench": {
    label: "Wrench",
    category: "tools",
    body: "<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z\"/>",
  },
  "drill": {
    label: "Drill",
    category: "tools",
    body: "<path d=\"M10 18a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H5a3 3 0 0 1-3-3 1 1 0 0 1 1-1z\"/><path d=\"M13 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1l-.81 3.242a1 1 0 0 1-.97.758H8\"/><path d=\"M14 4h3a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-3\"/><path d=\"M18 6h4\"/><path d=\"m5 10-2 8\"/><path d=\"m7 18 2-8\"/>",
  },
  "paint-bucket": {
    label: "Paint",
    category: "tools",
    body: "<path d=\"M11 7 6 2\"/><path d=\"M18.992 12H2.041\"/><path d=\"M21.145 18.38A3.34 3.34 0 0 1 20 16.5a3.3 3.3 0 0 1-1.145 1.88c-.575.46-.855 1.02-.855 1.595A2 2 0 0 0 20 22a2 2 0 0 0 2-2.025c0-.58-.285-1.13-.855-1.595\"/><path d=\"m8.5 4.5 2.148-2.148a1.205 1.205 0 0 1 1.704 0l7.296 7.296a1.205 1.205 0 0 1 0 1.704l-7.592 7.592a3.615 3.615 0 0 1-5.112 0l-3.888-3.888a3.615 3.615 0 0 1 0-5.112L5.67 7.33\"/>",
  },
  "palette": {
    label: "Palette",
    category: "tools",
    body: "<path d=\"M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z\"/><circle cx=\"13.5\" cy=\"6.5\" r=\".5\" fill=\"currentColor\"/><circle cx=\"17.5\" cy=\"10.5\" r=\".5\" fill=\"currentColor\"/><circle cx=\"6.5\" cy=\"12.5\" r=\".5\" fill=\"currentColor\"/><circle cx=\"8.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\"/>",
  },
  "package": {
    label: "Package",
    category: "tools",
    body: "<path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z\"/><path d=\"M12 22V12\"/><polyline points=\"3.29 7 12 12 20.71 7\"/><path d=\"m7.5 4.27 9 5.15\"/>",
  },
  "tractor": {
    label: "Tractor",
    category: "tools",
    body: "<path d=\"m10 11 11 .9a1 1 0 0 1 .8 1.1l-.665 4.158a1 1 0 0 1-.988.842H20\"/><path d=\"M16 18h-5\"/><path d=\"M18 5a1 1 0 0 0-1 1v5.573\"/><path d=\"M3 4h8.129a1 1 0 0 1 .99.863L13 11.246\"/><path d=\"M4 11V4\"/><path d=\"M7 15h.01\"/><path d=\"M8 10.1V4\"/><circle cx=\"18\" cy=\"18\" r=\"2\"/><circle cx=\"7\" cy=\"15\" r=\"5\"/>",
  },
  "check": {
    label: "Check",
    category: "status",
    body: "<path d=\"M20 6 9 17l-5-5\"/>",
  },
  "x": {
    label: "X",
    category: "status",
    body: "<path d=\"M18 6 6 18\"/><path d=\"m6 6 12 12\"/>",
  },
  "check-circle": {
    label: "Check (circle)",
    category: "status",
    body: "<path d=\"M21.801 10A10 10 0 1 1 17 3.335\"/><path d=\"m9 11 3 3L22 4\"/>",
  },
  "x-circle": {
    label: "X (circle)",
    category: "status",
    body: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"m15 9-6 6\"/><path d=\"m9 9 6 6\"/>",
  },
  "clock": {
    label: "Clock",
    category: "status",
    body: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 6v6l4 2\"/>",
  },
  "timer": {
    label: "Timer",
    category: "status",
    body: "<line x1=\"10\" x2=\"14\" y1=\"2\" y2=\"2\"/><line x1=\"12\" x2=\"15\" y1=\"14\" y2=\"11\"/><circle cx=\"12\" cy=\"14\" r=\"8\"/>",
  },
  "calendar": {
    label: "Calendar",
    category: "status",
    body: "<path d=\"M8 2v3\"/><path d=\"M16 2v3\"/><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M3 9h18\"/>",
  },
  "lock": {
    label: "Lock",
    category: "status",
    body: "<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/>",
  },
  "unlock": {
    label: "Unlock",
    category: "status",
    body: "<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 9.9-1\"/>",
  },
  "key": {
    label: "Key",
    category: "status",
    body: "<path d=\"m2 21 9.6-9.6\"/><path d=\"m7.5 15.5 2.3 2.3a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0L4 19\"/><circle cx=\"15.5\" cy=\"7.5\" r=\"5.5\"/>",
  },
  "eye": {
    label: "Eye",
    category: "status",
    body: "<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
  },
  "eye-off": {
    label: "Hidden",
    category: "status",
    body: "<path d=\"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49\"/><path d=\"M14.084 14.158a3 3 0 0 1-4.242-4.242\"/><path d=\"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143\"/><path d=\"m2 2 20 20\"/>",
  },
  "save": {
    label: "Save",
    category: "ui",
    body: "<path d=\"M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z\"/><path d=\"M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7\"/><path d=\"M7 3v4a1 1 0 0 0 1 1h7\"/>",
  },
  "pencil": {
    label: "Edit",
    category: "ui",
    body: "<path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\"/><path d=\"m15 5 4 4\"/>",
  },
  "pencil-line": {
    label: "Edit (line)",
    category: "ui",
    body: "<path d=\"M13 21h8\"/><path d=\"m15 5 4 4\"/><path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\"/>",
  },
  "trash-2": {
    label: "Delete",
    category: "ui",
    body: "<path d=\"M10 11v6\"/><path d=\"M14 11v6\"/><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"/><path d=\"M3 6h18\"/><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/>",
  },
  "copy": {
    label: "Copy",
    category: "ui",
    body: "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\"/><path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"/>",
  },
  "clipboard-copy": {
    label: "Clipboard",
    category: "ui",
    body: "<rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\" ry=\"1\"/><path d=\"M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v4\"/><path d=\"M21 14H11\"/><path d=\"m15 10-4 4 4 4\"/>",
  },
  "clipboard-paste": {
    label: "Paste",
    category: "ui",
    body: "<path d=\"M11 14h10\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v1.344\"/><path d=\"m17 18 4-4-4-4\"/><path d=\"M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113\"/><rect x=\"8\" y=\"2\" width=\"8\" height=\"4\" rx=\"1\"/>",
  },
  "plus": {
    label: "Add",
    category: "ui",
    body: "<path d=\"M5 12h14\"/><path d=\"M12 5v14\"/>",
  },
  "minus": {
    label: "Remove",
    category: "ui",
    body: "<path d=\"M5 12h14\"/>",
  },
  "download": {
    label: "Download",
    category: "ui",
    body: "<path d=\"M12 15V3\"/><path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><path d=\"m7 10 5 5 5-5\"/>",
  },
  "upload": {
    label: "Upload",
    category: "ui",
    body: "<path d=\"M12 3v12\"/><path d=\"m17 8-5-5-5 5\"/><path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/>",
  },
  "printer": {
    label: "Print",
    category: "ui",
    body: "<path d=\"M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2\"/><path d=\"M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6\"/><rect x=\"6\" y=\"14\" width=\"12\" height=\"8\" rx=\"1\"/>",
  },
  "share-2": {
    label: "Share",
    category: "ui",
    body: "<circle cx=\"18\" cy=\"5\" r=\"3\"/><circle cx=\"6\" cy=\"12\" r=\"3\"/><circle cx=\"18\" cy=\"19\" r=\"3\"/><line x1=\"8.59\" x2=\"15.42\" y1=\"13.51\" y2=\"17.49\"/><line x1=\"15.41\" x2=\"8.59\" y1=\"6.51\" y2=\"10.49\"/>",
  },
  "send": {
    label: "Send",
    category: "ui",
    body: "<path d=\"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z\"/><path d=\"m21.854 2.147-10.94 10.939\"/>",
  },
  "refresh-cw": {
    label: "Refresh",
    category: "ui",
    body: "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/><path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\"/><path d=\"M8 16H3v5\"/>",
  },
  "rotate-cw": {
    label: "Rotate",
    category: "ui",
    body: "<path d=\"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/>",
  },
  "undo-2": {
    label: "Undo",
    category: "ui",
    body: "<path d=\"M9 14 4 9l5-5\"/><path d=\"M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11\"/>",
  },
  "redo-2": {
    label: "Redo",
    category: "ui",
    body: "<path d=\"m15 14 5-5-5-5\"/><path d=\"M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13\"/>",
  },
  "search": {
    label: "Search",
    category: "ui",
    body: "<path d=\"m21 21-4.34-4.34\"/><circle cx=\"11\" cy=\"11\" r=\"8\"/>",
  },
  "filter": {
    label: "Filter",
    category: "ui",
    body: "<path d=\"M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z\"/>",
  },
  "filter-x": {
    label: "Clear filter",
    category: "ui",
    body: "<path d=\"M12.531 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14v6a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341l.427-.473\"/><path d=\"m16.5 3.5 5 5\"/><path d=\"m21.5 3.5-5 5\"/>",
  },
  "list-filter": {
    label: "Filter list",
    category: "ui",
    body: "<path d=\"M2 5h20\"/><path d=\"M6 12h12\"/><path d=\"M9 19h6\"/>",
  },
  "sliders-horizontal": {
    label: "Sliders",
    category: "ui",
    body: "<path d=\"M10 5H3\"/><path d=\"M12 19H3\"/><path d=\"M14 3v4\"/><path d=\"M16 17v4\"/><path d=\"M21 12h-9\"/><path d=\"M21 19h-5\"/><path d=\"M21 5h-7\"/><path d=\"M8 10v4\"/><path d=\"M8 12H3\"/>",
  },
  "arrow-down-az": {
    label: "Sort A-Z",
    category: "ui",
    body: "<path d=\"m3 16 4 4 4-4\"/><path d=\"M7 20V4\"/><path d=\"M20 8h-5\"/><path d=\"M15 10V6.5a2.5 2.5 0 0 1 5 0V10\"/><path d=\"M15 14h5l-5 6h5\"/>",
  },
  "arrow-up-az": {
    label: "Sort Z-A",
    category: "ui",
    body: "<path d=\"m3 8 4-4 4 4\"/><path d=\"M7 4v16\"/><path d=\"M20 8h-5\"/><path d=\"M15 10V6.5a2.5 2.5 0 0 1 5 0V10\"/><path d=\"M15 14h5l-5 6h5\"/>",
  },
  "arrow-down-up": {
    label: "Sort",
    category: "ui",
    body: "<path d=\"m3 16 4 4 4-4\"/><path d=\"M7 20V4\"/><path d=\"m21 8-4-4-4 4\"/><path d=\"M17 4v16\"/>",
  },
  "database": {
    label: "Query",
    category: "ui",
    body: "<ellipse cx=\"12\" cy=\"5\" rx=\"9\" ry=\"3\"/><path d=\"M3 5V19A9 3 0 0 0 21 19V5\"/><path d=\"M3 12A9 3 0 0 0 21 12\"/>",
  },
  "database-zap": {
    label: "Run query",
    category: "ui",
    body: "<ellipse cx=\"12\" cy=\"5\" rx=\"9\" ry=\"3\"/><path d=\"M3 5V19A9 3 0 0 0 15 21.84\"/><path d=\"M21 5V8\"/><path d=\"M21 12L18 17H22L19 22\"/><path d=\"M3 12A9 3 0 0 0 14.59 14.87\"/>",
  },
  "file-search": {
    label: "Find",
    category: "ui",
    body: "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\"/><path d=\"M14 2v5a1 1 0 0 0 1 1h5\"/><circle cx=\"11.5\" cy=\"14.5\" r=\"2.5\"/><path d=\"M13.3 16.3 15 18\"/>",
  },
  "settings": {
    label: "Settings",
    category: "ui",
    body: "<path d=\"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
  },
  "settings-2": {
    label: "Settings (alt)",
    category: "ui",
    body: "<path d=\"M14 17H5\"/><path d=\"M19 7h-9\"/><circle cx=\"17\" cy=\"17\" r=\"3\"/><circle cx=\"7\" cy=\"7\" r=\"3\"/>",
  },
  "cog": {
    label: "Gear",
    category: "ui",
    body: "<path d=\"M11 10.27 7 3.34\"/><path d=\"m11 13.73-4 6.93\"/><path d=\"M12 22v-2\"/><path d=\"M12 2v2\"/><path d=\"M14 12h8\"/><path d=\"m17 20.66-1-1.73\"/><path d=\"m17 3.34-1 1.73\"/><path d=\"M2 12h2\"/><path d=\"m20.66 17-1.73-1\"/><path d=\"m20.66 7-1.73 1\"/><path d=\"m3.34 17 1.73-1\"/><path d=\"m3.34 7 1.73 1\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/><circle cx=\"12\" cy=\"12\" r=\"8\"/>",
  },
  "menu": {
    label: "Menu",
    category: "ui",
    body: "<path d=\"M4 5h16\"/><path d=\"M4 12h16\"/><path d=\"M4 19h16\"/>",
  },
  "more-horizontal": {
    label: "More",
    category: "ui",
    body: "<circle cx=\"12\" cy=\"12\" r=\"1\"/><circle cx=\"19\" cy=\"12\" r=\"1\"/><circle cx=\"5\" cy=\"12\" r=\"1\"/>",
  },
  "more-vertical": {
    label: "More (vertical)",
    category: "ui",
    body: "<circle cx=\"12\" cy=\"12\" r=\"1\"/><circle cx=\"12\" cy=\"5\" r=\"1\"/><circle cx=\"12\" cy=\"19\" r=\"1\"/>",
  },
  "link": {
    label: "Link",
    category: "ui",
    body: "<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\"/><path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\"/>",
  },
  "paperclip": {
    label: "Attach",
    category: "ui",
    body: "<path d=\"m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551\"/>",
  },
  "pin": {
    label: "Pin",
    category: "ui",
    body: "<path d=\"M12 17v5\"/><path d=\"M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z\"/>",
  },
  "tag": {
    label: "Tag",
    category: "ui",
    body: "<path d=\"M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z\"/><circle cx=\"7.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\"/>",
  },
  "bell": {
    label: "Notify",
    category: "ui",
    body: "<path d=\"M10.268 21a2 2 0 0 0 3.464 0\"/><path d=\"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326\"/>",
  },
  "arrow-right": {
    label: "Next",
    category: "ui",
    body: "<path d=\"M5 12h14\"/><path d=\"m12 5 7 7-7 7\"/>",
  },
  "arrow-left": {
    label: "Back",
    category: "ui",
    body: "<path d=\"m12 19-7-7 7-7\"/><path d=\"M19 12H5\"/>",
  },
  "arrow-up": {
    label: "Up",
    category: "ui",
    body: "<path d=\"m5 12 7-7 7 7\"/><path d=\"M12 19V5\"/>",
  },
  "arrow-down": {
    label: "Down",
    category: "ui",
    body: "<path d=\"M12 5v14\"/><path d=\"m19 12-7 7-7-7\"/>",
  },
  "play": {
    label: "Play",
    category: "ui",
    body: "<path d=\"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z\"/>",
  },
  "pause": {
    label: "Pause",
    category: "ui",
    body: "<rect x=\"14\" y=\"3\" width=\"5\" height=\"18\" rx=\"1\"/><rect x=\"5\" y=\"3\" width=\"5\" height=\"18\" rx=\"1\"/>",
  },
  "circle-stop": {
    label: "Stop",
    category: "ui",
    body: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><rect x=\"9\" y=\"9\" width=\"6\" height=\"6\" rx=\"1\"/>",
  },
  "rotate-ccw": {
    label: "Reset",
    category: "ui",
    body: "<path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\"/><path d=\"M3 3v5h5\"/>",
  },
};

/** Ordered list of categories, for the picker's category select. */
export const MAP_ICON_CATEGORIES = ["ui","markers","buildings","public-safety","transportation","nature","utilities","services","communication","people","science","tools","status"] as const;

/** Inline SVG element wrapping an entry's body. Used by the
 *  icon-picker grid + by the canvas rasterizer for MapLibre
 *  image registration. Sized at the lucide-native 24x24 so
 *  strokes hit pixel boundaries; the consumer applies its own
 *  scaling. */
export function renderIconSvg(
  name: string,
  opts: { stroke?: string; strokeWidth?: number } = {},
): string | null {
  const icon = MAP_ICONS[name];
  if (!icon) return null;
  // Both values are interpolated into markup that callers set with
  // innerHTML, and the stroke comes from map style data an author
  // controls. Only a value that cannot leave the attribute gets in.
  const stroke = safeCssColor(opts.stroke, 'currentColor');
  const width = Number(opts.strokeWidth ?? 2);
  const w = Number.isFinite(width) ? width : 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ` +
    `fill="none" stroke="${stroke}" stroke-width="${w}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${icon.body}</svg>`;
}

/**
 * Variant of renderIconSvg used for the SDF rasterization
 * pass. The SDF image must be a single-channel alpha mask in
 * pure black; MapLibre's SDF renderer tints it at draw time
 * via `icon-color`. Differs from renderIconSvg only in stroke
 * color (#000) -- everything else lines up.
 */
export function renderIconSvgForSdf(name: string): string | null {
  return renderIconSvg(name, { stroke: '#000' });
}

/** Stable MapLibre image ID for an icon's plain raster
 *  variant (renders in its shipped color). */
export function iconImageId(name: string): string {
  return `gg:icon:${name}`;
}

/** Stable MapLibre image ID for an icon's SDF variant
 *  (tintable via the layer's icon-color paint property). */
export function iconSdfImageId(name: string): string {
  return `gg:icon-sdf:${name}`;
}
