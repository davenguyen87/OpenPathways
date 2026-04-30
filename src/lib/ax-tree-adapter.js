/**
 * Accessibility Tree Adapter
 * Wraps Playwright's page.accessibility.snapshot() and provides query helpers.
 *
 * Normalizes the tree structure for ergonomic access and robustness.
 */

/**
 * Takes a Playwright Page, captures its accessibility tree snapshot.
 * Normalizes properties array into a flat object.
 *
 * Playwright >= 1.45 removed `page.accessibility.snapshot()`. We prefer CDP
 * (chromium only) and fall back to the legacy API if it's still present (older
 * Playwright versions). For firefox/webkit on modern Playwright, this returns
 * null and dynamic checks treat that page as unsnapshottable.
 *
 * @param {object} page - Playwright Page object
 * @returns {Promise<object|null>} Normalized tree node, or null on failure
 */
async function snapshot(page) {
  // Legacy path (Playwright < 1.45)
  if (page.accessibility && typeof page.accessibility.snapshot === 'function') {
    const raw = await page.accessibility.snapshot();
    return normalizeNode(raw);
  }

  // Modern path: CDP (chromium-only)
  const ctx = page.context && page.context();
  if (ctx && typeof ctx.newCDPSession === 'function') {
    let session;
    try {
      session = await ctx.newCDPSession(page);
      await session.send('Accessibility.enable');
      const { nodes } = await session.send('Accessibility.getFullAXTree');
      return rebuildFromCDP(nodes);
    } catch (err) {
      // Non-chromium browser or AX disabled; surface as null and let caller skip.
      return null;
    } finally {
      if (session) {
        try { await session.detach(); } catch (_) { /* ignore */ }
      }
    }
  }

  return null;
}

/**
 * Rebuild a normalized tree from the flat CDP node list.
 *
 * @param {Array} nodes - Output of Accessibility.getFullAXTree
 * @returns {object|null} Normalized tree root, or null if input is empty
 */
function rebuildFromCDP(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const byId = new Map();
  for (const n of nodes) byId.set(n.nodeId, n);

  // Root is the node not referenced as a child by any other node.
  const referencedAsChild = new Set();
  for (const n of nodes) {
    if (Array.isArray(n.childIds)) n.childIds.forEach((c) => referencedAsChild.add(c));
  }
  const root = nodes.find((n) => !referencedAsChild.has(n.nodeId)) || nodes[0];

  return convertCDPNode(root, byId);
}

function convertCDPNode(cdp, byId) {
  if (!cdp) return null;

  const properties = {};
  if (Array.isArray(cdp.properties)) {
    for (const p of cdp.properties) {
      if (p && p.name && p.value && p.value.value !== undefined) {
        properties[p.name] = p.value.value;
      }
    }
  }

  const children = [];
  if (Array.isArray(cdp.childIds)) {
    for (const cid of cdp.childIds) {
      const child = byId.get(cid);
      if (child) {
        const converted = convertCDPNode(child, byId);
        if (converted) children.push(converted);
      }
    }
  }

  return {
    role: (cdp.role && cdp.role.value) || null,
    name: (cdp.name && cdp.name.value) || null,
    value: (cdp.value && cdp.value.value) || null,
    description: (cdp.description && cdp.description.value) || null,
    children: children,
    properties: properties,
  };
}

/**
 * Recursively normalize a node from Playwright's snapshot.
 * Converts properties array [{name, value}, ...] into flat object.
 *
 * @param {object} node - Raw node from page.accessibility.snapshot()
 * @returns {object} Normalized node
 */
function normalizeNode(node) {
  if (!node) return null;

  // Convert properties array to flat object
  const properties = {};
  if (Array.isArray(node.properties)) {
    for (const prop of node.properties) {
      if (prop && prop.name && prop.value !== undefined) {
        properties[prop.name] = prop.value;
      }
    }
  }

  // Normalize children recursively
  const children = [];
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const normalized = normalizeNode(child);
      if (normalized) children.push(normalized);
    }
  }

  return {
    role: node.role || null,
    name: node.name || null,
    value: node.value || null,
    description: node.description || null,
    children: children,
    properties: properties,
  };
}

/**
 * Find all nodes in tree matching a role (case-insensitive).
 * Returns array of matching nodes (DFS order).
 *
 * @param {object} node - Root node
 * @param {string} role - Role to find (e.g., "button", "heading")
 * @returns {Array} Array of matching nodes
 */
function findByRole(node, role) {
  const results = [];
  const roleLC = (role || '').toLowerCase();

  walk(node, (n) => {
    if ((n.role || '').toLowerCase() === roleLC) {
      results.push(n);
    }
  });

  return results;
}

/**
 * Find all nodes in tree matching a name.
 * If nameOrRegex is a string, case-insensitive substring match.
 * If it's a RegExp, test against node.name.
 *
 * @param {object} node - Root node
 * @param {string|RegExp} nameOrRegex - Name string or regex pattern
 * @returns {Array} Array of matching nodes
 */
function findByName(node, nameOrRegex) {
  const results = [];
  const isRegex = nameOrRegex instanceof RegExp;

  walk(node, (n) => {
    if (!n.name) return;

    let match = false;
    if (isRegex) {
      match = nameOrRegex.test(n.name);
    } else {
      match = n.name.toLowerCase().includes((nameOrRegex || '').toLowerCase());
    }

    if (match) {
      results.push(n);
    }
  });

  return results;
}

/**
 * Depth-first traversal of the tree.
 * Visitor called as visitor(node, parent, depth).
 *
 * @param {object} node - Root node
 * @param {function} visitor - Called for each node (node, parent, depth)
 */
function walk(node, visitor) {
  if (!node) return;

  function traverse(n, parent, depth) {
    visitor(n, parent, depth);

    if (Array.isArray(n.children)) {
      for (const child of n.children) {
        traverse(child, n, depth + 1);
      }
    }
  }

  traverse(node, null, 0);
}

/**
 * Flatten tree into a single array of all descendant nodes.
 * Depth-first order.
 *
 * @param {object} node - Root node
 * @returns {Array} Flat array of nodes
 */
function flatten(node) {
  const results = [];
  walk(node, (n) => results.push(n));
  return results;
}

/**
 * Extract focusable elements in DOM order.
 * Returns array of objects: { role, name, tabindex, node }.
 * Includes elements with tabindex >= -1 and interactive roles.
 *
 * @param {object} node - Root node
 * @returns {Array} Focusable sequence
 */
function extractFocusableSequence(node) {
  const all = flatten(node);

  // Interactive roles that are naturally focusable
  const interactiveRoles = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'listbox',
    'option',
    'radio',
    'checkbox',
    'slider',
    'spinbutton',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
  ]);

  const focusable = [];

  for (const n of all) {
    const tabindex = parseInt(n.properties.tabindex, 10);

    // Include if has explicit tabindex >= -1 or interactive role
    if (!isNaN(tabindex) && tabindex >= -1) {
      focusable.push({
        role: n.role,
        name: n.name,
        tabindex: tabindex,
        node: n,
      });
    } else if (interactiveRoles.has((n.role || '').toLowerCase())) {
      focusable.push({
        role: n.role,
        name: n.name,
        tabindex: -1,  // default tabindex for interactive elements
        node: n,
      });
    }
  }

  return focusable;
}

/**
 * Find all aria-live and role="status" regions.
 * Returns array of objects: { node, liveType: 'polite'|'assertive'|'off', isStatus: bool }.
 *
 * @param {object} node - Root node
 * @returns {Array} Live regions found
 */
function findLiveRegions(node) {
  const results = [];
  const all = flatten(node);

  for (const n of all) {
    const ariaLive = n.properties['aria-live'];
    const role = (n.role || '').toLowerCase();
    const isStatus = role === 'status' || role === 'alert';

    // aria-live attribute (polite, assertive, off)
    if (ariaLive) {
      results.push({
        node: n,
        liveType: ariaLive.toLowerCase(),
        isStatus: isStatus,
      });
    }
    // role="status" or role="alert"
    else if (isStatus) {
      results.push({
        node: n,
        liveType: 'polite',  // default for status
        isStatus: true,
      });
    }
  }

  return results;
}

module.exports = {
  snapshot,
  findByRole,
  findByName,
  walk,
  flatten,
  extractFocusableSequence,
  findLiveRegions,
};
