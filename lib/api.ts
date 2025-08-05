import fs from "fs";
import { globSync } from "glob";
import path from "path";
import matter from "gray-matter";

import { toHTML } from "./markdown";

const contentDir = path.join(process.cwd(), "content").replace(/\\/g, "/");

// Merge app level props in with page props
export function withAppProps(
  props: { props: Record<PropertyKey, unknown> } = { props: {} }
) {
  const blog = getLastBlog();
  delete blog.body;
  props.props.app = {
    blog,
  };

  return props;
}

export function getMenuPaths(menu) {
  let paths = collectPaths(menu).map((slug) => {
    [, ...slug] = slug.split("/");

    return {
      params: { slug },
    };
  });

  return {
    paths,
    fallback: false,
  };
}

export function getLastBlog() {
  return getDateOrderedPaths("blog")[0];
}

export function getDateOrderedPaths(root) {
  return globSync(`${contentDir}/${root}/*.md`)
    .map((fullPath) => {
      const path = fullPath.replace(`${contentDir}/`, "").replace(/\.md$/, "");
      const page = loadPage(path);

      return {
        date: Date.parse(page.data.date),
        ...page,
      };
    })
    .sort((a, b) => {
      return b.date - a.date;
    });
}

export async function getProps(menu, slug) {
  if (Array.isArray(slug)) {
    slug = slug.join(path.sep);
  }

  const [root] = slug.split(path.sep);
  const page = loadPage(`${slug}`);
  page.body = await toHTML(page.body);

  const normalized = [
    {
      key: root,
      title: menu[root].title,
      nested: normalize(menu[root].nested, root),
    },
  ];

  setPrevNext(page, normalized);

  return withAppProps({
    props: {
      page,
      menu: normalized,
    },
  });
}

function setPrevNext(page, menu) {
  let didMatch = false;

  eachPage(
    menu,
    (p, prev) => {
      if (p.href == page.href) {
        didMatch = true;

        if (prev && prev.title) {
          page.prev = {
            title: prev.menuTitle || prev.title,
            href: prev.href,
          };
        }
      } else if (didMatch) {
        page.next = {
          title: p.menuTitle || p.title,
          href: p.href,
        };

        didMatch = false;
      }
    },
    undefined,
    undefined
  );

  return page;
}

// Build a list of paths from the sitemap
function collectPaths(
  level: Record<string, { nested?: string[]; href?: string }>,
  prefix = ""
) {
  let out = [];

  for (const [k, v] of Object.entries(level)) {
    if (!v.href) {
      out.push(`${prefix}/${k}`);
    }

    if (Array.isArray(v.nested)) {
      for (const p of v.nested) {
        let child = {};
        child[p] = {};
        out = out.concat(collectPaths(child, `${prefix}/${k}`));
      }
    } else if (v.nested) {
      out = out.concat(collectPaths(v.nested, `${prefix}/${k}`));
    }
  }

  return out;
}

// Normalize the sitemap using front matter
function normalize(menu, root) {
  let out = [];

  // Level 1 of menu may be single pages or contain a sub structure
  for (const l1 of Object.keys(menu)) {
    if (menu[l1].href) {
      // The menu entry is an external link and does not have an associated markdown page.
      out.push({
        page: {
          key: l1,
          ...menu[l1],
        },
      });
    } else if (!menu[l1].nested) {
      // Single page
      out.push({
        page: loadMenuPage(`${root}/${l1}`),
      });
    } else {
      // Load front matter for sub pages
      let submenu = [];

      for (const l2 of menu[l1].nested) {
        submenu.push({
          page: loadMenuPage(`${root}/${l1}/${l2}`),
        });
      }

      out.push({
        page: loadMenuPage(`${root}/${l1}`),
        nested: submenu,
      });
    }
  }

  return out;
}

export function loadPage(pathArgument: string) {
  const normalizedContentDir = path.normalize(contentDir);

  let relativePath = pathArgument;

  if (path.isAbsolute(pathArgument)) {
    const pathFromCwd = path.relative(process.cwd(), pathArgument);
    if (
      pathFromCwd.startsWith(path.sep + "content" + path.sep) ||
      pathFromCwd.startsWith("content" + path.sep)
    ) {
      relativePath = pathFromCwd.substring("content".length + 1);
    }
  } else if (
    pathArgument.includes(normalizedContentDir) ||
    pathArgument.includes(contentDir)
  ) {
    let prefixToRemove = normalizedContentDir;
    if (!pathArgument.startsWith(prefixToRemove)) {
      prefixToRemove = contentDir;
    }
    if (pathArgument.startsWith(prefixToRemove)) {
      relativePath = pathArgument.substring(prefixToRemove.length);
      if (relativePath.startsWith(path.sep) || relativePath.startsWith("/")) {
        relativePath = relativePath.substring(1);
      }
    }
  }

  if (relativePath.startsWith("./" + path.sep))
    relativePath = relativePath.substring(2);
  if (relativePath.startsWith("./")) relativePath = relativePath.substring(2);

  const parts = relativePath.split(path.sep);
  const base = path.join(normalizedContentDir, relativePath);
  const fullPathMdFile = path.join(base + ".md");
  const fullPathIndexMdFile = path.join(base, "index.md");

  let mdPath;
  let fileContents;

  if (fs.existsSync(fullPathMdFile)) {
    fileContents = fs.readFileSync(fullPathMdFile, "utf-8");
    mdPath = `${relativePath}.md`;
  } else if (fs.existsSync(fullPathIndexMdFile)) {
    fileContents = fs.readFileSync(fullPathIndexMdFile, "utf-8");
    mdPath = path.join(relativePath, "index.md");
  } else {
    throw new Error(
      `ENOENT: no such file or directory, tried '${fullPathMdFile}' and '${fullPathIndexMdFile}'`
    );
  }

  const res = matter(fileContents);

  return {
    key: parts[parts.length - 1],
    href: `/${relativePath.replace(/\\/g, "/")}`,
    title: res.data.title,
    menuTitle: res.data.menu || res.data.title,
    mdPath: mdPath.replace(/\\/g, "/"),
    data: res.data,
    body: res.content,
    description: res.data.description || null,
  };
}

function loadMenuPage(path) {
  let page = loadPage(path);

  return {
    key: page.key,
    href: page.href,
    title: page.menuTitle,
    data: page.data,
  };
}

function eachPage(menu, f, prev, prevSection) {
  for (const entry of menu) {
    if (entry.page && entry.page.data) {
      f(entry.page, prev || (prevSection && prevSection.page));
      prev = entry.page;
    }

    if (entry.nested) {
      eachPage(entry.nested, f, entry.page, prev);
    }
  }
}
