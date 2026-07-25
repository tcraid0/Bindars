import React from "react";

/**
 * Flattens rendered code children (including syntax-highlight spans) into plain text.
 */
export function extractCodeText(node: React.ReactNode): string {
  return React.Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }

      if (React.isValidElement<{ children?: React.ReactNode }>(child)) {
        return extractCodeText(child.props.children);
      }

      return "";
    })
    .join("");
}
