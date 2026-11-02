// Content collections, built into the Worker at build time. Each FAQ entry is named after its locale.
import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";

const faq = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/faq" }),
});

export const collections = { faq };
