(() => {
  const capturePath = '/__zapp/events';
  const nativeFetch = window.fetch.bind(window);
  const nativeConsole = {
    error: window.console.error.bind(window.console),
    log: window.console.log.bind(window.console),
    warn: window.console.warn.bind(window.console),
  };
  const maxCaptureTextChars = 4_096;
  const maxCaptureUploadConcurrency = 1;
  const maxCaptureUploadQueue = 100;
  const maxCaptureUrlChars = 2_048;
  const maxSelectionComponentChars = 256;
  const maxSelectionSelectorChars = 2_048;
  const maxSelectionTextChars = 4_096;
  const maxSelectorTraversalNodes = 256;
  const redacted = '[REDACTED]';
  const secretNamePattern = /authorization|cookie|pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?key|credential|session|signature|code/i;
  const secretAssignmentPattern = /\b(authorization|cookie|pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?key|credential|session|signature|code)\b(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;
  const capturedUrlPattern = /https?:\/\/[^\s"'<>]+/gi;
  let activeCaptureUploads = 0;
  let captureInProgress = false;
  const captureUploadQueue = [];
  let selectionEnabled = false;
  let outlinedElement;
  let outlinedElementOutline;

  const httpOrigin = (value, exactOrigin = false) => {
    if (typeof value !== 'string') {
      return undefined;
    }

    try {
      const url = new URL(value);
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:')
        || (exactOrigin && (url.username || url.password || url.pathname !== '/' || url.search || url.hash))
      ) {
        return undefined;
      }

      return url.origin;
    } catch {
      return undefined;
    }
  };

  const configuredParentOrigin = /*__ZAPP_PARENT_ORIGIN__*/ null;
  const parentOrigin =
    typeof configuredParentOrigin === 'string'
      ? httpOrigin(configuredParentOrigin, true)
      : window.parent === window
        ? httpOrigin(window.location.href)
        : undefined;

  const postToParent = (message) => {
    if (!parentOrigin) {
      return;
    }

    window.parent.postMessage(message, parentOrigin);
  };

  const isTrustedParentMessage = (event) =>
    parentOrigin !== undefined && event.source === window.parent && event.origin === parentOrigin;

  const isCaptureRequest = (url) => {
    try {
      const requestUrl = new URL(url, window.location.href);
      return requestUrl.origin === window.location.origin && requestUrl.pathname === capturePath;
    } catch {
      return false;
    }
  };

  const truncate = (value, maxCharacters) => {
    if (value.length <= maxCharacters) {
      return value;
    }

    const suffix = '…[TRUNCATED]';
    return `${value.slice(0, maxCharacters - suffix.length)}${suffix}`;
  };

  const sanitizeUrl = (value) => {
    try {
      const url = new URL(value, window.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return redacted;
      }
      url.username = '';
      url.password = '';
      url.hash = '';
      for (const name of [...url.searchParams.keys()]) {
        if (secretNamePattern.test(name)) {
          url.searchParams.set(name, redacted);
        }
      }
      return truncate(url.href, maxCaptureUrlChars);
    } catch {
      return redacted;
    }
  };

  const sanitizeText = (value) => {
    const sanitizedUrls = value.replace(capturedUrlPattern, (candidate) => {
      const trailing = candidate.match(/[),.;!?]+$/)?.[0] || '';
      const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
      return `${sanitizeUrl(url)}${trailing}`;
    });
    const sanitizedCredentials = sanitizedUrls.replace(
      /\b(Bearer|Basic)\s+[^\s,;]+/gi,
      `$1 ${redacted}`,
    );
    const sanitizedAssignments = sanitizedCredentials.replace(
      secretAssignmentPattern,
      (_match, name, separator) => `${name}${separator}${redacted}`,
    );
    return truncate(sanitizedAssignments, maxCaptureTextChars);
  };

  const safeSerialize = (value) => {
    if (typeof value === 'string') {
      return sanitizeText(value);
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (typeof value === 'bigint') {
      return `${String(value)}n`;
    }
    if (typeof value === 'undefined') {
      return 'undefined';
    }
    if (typeof value === 'function') {
      return '[Function]';
    }
    if (typeof value === 'symbol') {
      return '[Symbol]';
    }
    return '[OpaqueObject]';
  };

  const errorDetails = (reason, fallbackMessage) => {
    const primitiveReason = typeof reason === 'string' ? safeSerialize(reason) : undefined;
    return {
      message: sanitizeText(primitiveReason || fallbackMessage || safeSerialize(reason)),
      stack: sanitizeText(new Error().stack || ''),
    };
  };

  const drainCaptureUploads = () => {
    while (activeCaptureUploads < maxCaptureUploadConcurrency && captureUploadQueue.length > 0) {
      const event = captureUploadQueue.shift();
      activeCaptureUploads += 1;
      let upload;
      try {
        upload = nativeFetch(capturePath, {
          body: JSON.stringify(event),
          headers: {
            'content-type': 'application/json',
            'idempotency-key': window.crypto.randomUUID(),
          },
          method: 'POST',
        });
      } catch {
        activeCaptureUploads -= 1;
        continue;
      }
      void Promise.resolve(upload)
        .catch(() => undefined)
        .then(() => {
          activeCaptureUploads -= 1;
          drainCaptureUploads();
        });
    }
  };

  const send = (event) => {
    try {
      if (captureUploadQueue.length >= maxCaptureUploadQueue) {
        return;
      }
      captureUploadQueue.push(event);
      drainCaptureUploads();
    } catch {
      // Capture is best-effort and must never break the page.
    }
  };

  const capture = (createEvent) => {
    if (captureInProgress) {
      return;
    }

    captureInProgress = true;
    try {
      send(createEvent());
    } catch {
      // Page-controlled values and hooks cannot make instrumentation throw.
    } finally {
      captureInProgress = false;
    }
  };

  const messageFor = (values) => truncate(values.map((value) => safeSerialize(value)).join(' '), maxCaptureTextChars);

  for (const level of ['log', 'warn', 'error']) {
    window.console[level] = (...values) => {
      nativeConsole[level](...values);
      capture(() => ({
        payload: {
          level,
          message: messageFor(values),
          stack: sanitizeText(new Error().stack || ''),
        },
        type: 'console',
      }));
    };
  }

  window.addEventListener('error', (event) => {
    capture(() => {
      let fallbackMessage = 'Uncaught error';
      let error;
      try {
        fallbackMessage = typeof event.message === 'string' && event.message ? event.message : fallbackMessage;
        error = event.error;
      } catch {
        // Use the bounded fallback when a synthetic event exposes hostile accessors.
      }
      return { payload: errorDetails(error, fallbackMessage), type: 'runtime_error' };
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    capture(() => {
      let reason;
      try {
        reason = event.reason;
      } catch {
        reason = '[Unserializable rejection]';
      }
      return { payload: errorDetails(reason, 'Unhandled rejection'), type: 'runtime_error' };
    });
  });

  window.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : new URL(String(input), window.location.href).href;
    const method = (init && init.method) || (input instanceof Request && input.method) || 'GET';

    if (isCaptureRequest(url)) {
      return nativeFetch(input, init);
    }

    const startedAt = Date.now();
    try {
      const response = await nativeFetch(input, init);
      capture(() => ({
        payload: {
          durationMs: Date.now() - startedAt,
          method: safeSerialize(method),
          status: response.status,
          transport: 'fetch',
          url: sanitizeUrl(url),
        },
        type: 'network',
      }));
      return response;
    } catch (error) {
      capture(() => ({
        payload: {
          durationMs: Date.now() - startedAt,
          method: safeSerialize(method),
          status: 0,
          transport: 'fetch',
          url: sanitizeUrl(url),
        },
        type: 'network',
      }));
      throw error;
    }
  };

  const nativeOpen = window.XMLHttpRequest.prototype.open;
  const nativeSend = window.XMLHttpRequest.prototype.send;

  window.XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
    this.__zappRequest = {
      method: String(method),
      url: new URL(String(url), window.location.href).href,
    };
    return nativeOpen.call(this, method, url, ...rest);
  };

  window.XMLHttpRequest.prototype.send = function sendXhr(...args) {
    const request = this.__zappRequest;

    if (!request || isCaptureRequest(request.url)) {
      return nativeSend.apply(this, args);
    }

    const startedAt = Date.now();
    this.addEventListener(
      'loadend',
      () => {
        capture(() => ({
          payload: {
            durationMs: Date.now() - startedAt,
            method: safeSerialize(request.method),
            status: this.status,
            transport: 'xhr',
            url: sanitizeUrl(this.responseURL || request.url),
          },
          type: 'network',
        }));
      },
      { once: true },
    );
    return nativeSend.apply(this, args);
  };

  const reportRoute = () => capture(() => ({
    payload: { url: sanitizeUrl(window.location.href) },
    type: 'route_change',
  }));
  for (const method of ['pushState', 'replaceState']) {
    const nativeHistoryMethod = window.history[method].bind(window.history);
    window.history[method] = (...args) => {
      const result = nativeHistoryMethod(...args);
      reportRoute();
      return result;
    };
  }
  window.addEventListener('popstate', reportRoute);
  window.addEventListener('hashchange', reportRoute);

  const escapeIdentifier = (value) => {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }

    return String(value).replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  };

  const escapeAttributeValue = (value) =>
    String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\A ')
      .replace(/\r/g, '\\D ')
      .replace(/\f/g, '\\C ');

  const uniquelySelects = (selector, element) => {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === element;
    } catch {
      return false;
    }
  };

  const uniquePreferredSelector = (element) => {
    const candidates = [];
    if (element.id) {
      candidates.push(`#${escapeIdentifier(element.id)}`);
    }
    for (const attribute of ['data-testid', 'aria-label']) {
      const value = element.getAttribute(attribute);
      if (value) {
        candidates.push(`[${attribute}="${escapeAttributeValue(value)}"]`);
      }
    }

    return candidates.find((selector) => uniquelySelects(selector, element));
  };

  const nthOfType = (element) => {
    let index = 1;
    let sibling = element.previousElementSibling;
    let traversed = 0;
    const seen = new WeakSet();
    while (sibling && traversed < maxSelectorTraversalNodes) {
      if (seen.has(sibling)) {
        throw new Error('Cyclic sibling traversal');
      }
      seen.add(sibling);
      traversed += 1;
      if (sibling.localName === element.localName) {
        index += 1;
      }
      sibling = sibling.previousElementSibling;
    }
    if (sibling) {
      throw new Error('Sibling traversal exceeded its bound');
    }

    return index;
  };

  const selectorFor = (element) => {
    const preferred = uniquePreferredSelector(element);
    if (preferred) {
      return preferred;
    }

    const parts = [];
    let current = element;
    let traversed = 0;
    const seen = new WeakSet();
    while (current && traversed < maxSelectorTraversalNodes) {
      if (seen.has(current)) {
        throw new Error('Cyclic ancestor traversal');
      }
      seen.add(current);
      traversed += 1;
      parts.unshift(
        uniquePreferredSelector(current)
          || `${escapeIdentifier(current.localName)}:nth-of-type(${nthOfType(current)})`,
      );
      const selector = parts.join(' > ');
      if (uniquelySelects(selector, element)) {
        return selector;
      }
      current = current.parentElement;
    }
    if (current) {
      throw new Error('Ancestor traversal exceeded its bound');
    }

    return parts.join(' > ');
  };

  const validRoles = new Set([
    'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption',
    'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo',
    'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure',
    'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
    'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option',
    'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
    'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status',
    'strong', 'subscript', 'suggestion', 'superscript', 'switch', 'tab', 'table', 'tablist',
    'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid',
    'treeitem',
  ]);

  validRoles.add('image');

  const presentationalRoles = new Set(['none', 'presentation']);
  const globalAriaAttributes = [
    'aria-atomic', 'aria-busy', 'aria-controls', 'aria-current', 'aria-description',
    'aria-describedby', 'aria-details', 'aria-disabled', 'aria-dropeffect', 'aria-errormessage',
    'aria-flowto', 'aria-grabbed', 'aria-haspopup', 'aria-hidden', 'aria-invalid',
    'aria-keyshortcuts', 'aria-label', 'aria-labelledby', 'aria-live', 'aria-owns',
    'aria-relevant', 'aria-roledescription',
  ];
  const buttonRoles = new Set([
    'button', 'checkbox', 'combobox', 'gridcell', 'link', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'radio', 'separator', 'slider', 'switch', 'tab', 'treeitem',
  ]);
  const linkRoles = new Set([
    'button', 'checkbox', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
    'radio', 'switch', 'tab', 'treeitem',
  ]);
  const imageRoles = new Set([
    'button', 'checkbox', 'image', 'img', 'link', 'math', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'meter', 'option', 'progressbar', 'radio', 'scrollbar', 'separator',
    'slider', 'switch', 'tab', 'treeitem',
  ]);
  const listRoles = new Set([
    'group', 'list', 'listbox', 'menu', 'menubar', 'none', 'presentation', 'radiogroup',
    'tablist', 'toolbar', 'tree',
  ]);

  const hasAccessibleName = (element) =>
    ['aria-label', 'aria-labelledby', 'title'].some((attribute) => {
      const value = element.getAttribute(attribute);
      return typeof value === 'string' && value.trim().length > 0;
    });

  const hasGlobalAriaAttribute = (element) =>
    globalAriaAttributes.some((attribute) => element.hasAttribute(attribute));

  const isNativeFocusable = (element) => {
    if (element.hasAttribute('disabled')) {
      return false;
    }
    const name = element.localName;
    if ((name === 'a' || name === 'area') && element.hasAttribute('href')) {
      return true;
    }
    if (name === 'button' || name === 'select' || name === 'textarea') {
      return true;
    }
    if (name === 'input' && (element.getAttribute('type') || 'text').toLowerCase() !== 'hidden') {
      return true;
    }
    if (element.hasAttribute('tabindex')) {
      return /^-?\d+$/.test(element.getAttribute('tabindex') || '');
    }
    const contentEditable = element.getAttribute('contenteditable');
    return contentEditable !== null && contentEditable.toLowerCase() !== 'false';
  };

  const hasPresentationalTableAncestor = (element) => {
    const tableChainNames = new Set(['table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']);
    const seen = new WeakSet();
    let ancestor = element.parentElement;
    for (let traversed = 0; ancestor && traversed < maxSelectorTraversalNodes; traversed += 1) {
      if (seen.has(ancestor) || !tableChainNames.has(ancestor.localName)) {
        return false;
      }
      seen.add(ancestor);
      const role = (ancestor.getAttribute('role') || '')
        .toLowerCase()
        .split(/\s+/)
        .find((candidate) => presentationalRoles.has(candidate));
      if (role && !isNativeFocusable(ancestor)) {
        return true;
      }
      if (ancestor.localName === 'table') {
        return false;
      }
      ancestor = ancestor.parentElement;
    }
    return false;
  };

  const hasListParent = (element) => {
    const parent = element.parentElement;
    if (!parent) {
      return false;
    }
    if (['menu', 'ol', 'ul'].includes(parent.localName)) {
      return !['none', 'presentation'].includes((parent.getAttribute('role') || '').trim().toLowerCase());
    }
    return (parent.getAttribute('role') || '')
      .toLowerCase()
      .split(/\s+/)
      .some((role) => role === 'list');
  };

  const isInsideLandmarkSection = (element) => {
    const seen = new WeakSet();
    let ancestor = element.parentElement;
    for (let traversed = 0; ancestor && traversed < maxSelectorTraversalNodes; traversed += 1) {
      if (seen.has(ancestor)) {
        return true;
      }
      seen.add(ancestor);
      if (['article', 'aside', 'main', 'nav', 'section'].includes(ancestor.localName)) {
        return true;
      }
      const role = (ancestor.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
      if (['article', 'complementary', 'main', 'navigation', 'region'].includes(role)) {
        return true;
      }
      ancestor = ancestor.parentElement;
    }
    return ancestor !== null;
  };

  const implicitRoleFor = (element) => {
    const name = element.localName;
    if (
      ['tbody', 'td', 'tfoot', 'th', 'thead', 'tr'].includes(name)
      && hasPresentationalTableAncestor(element)
    ) {
      return 'generic';
    }
    const directRoles = {
      address: 'group',
      article: 'article',
      aside: 'complementary',
      blockquote: 'blockquote',
      button: 'button',
      caption: 'caption',
      code: 'code',
      datalist: 'listbox',
      dd: 'definition',
      del: 'deletion',
      details: 'group',
      dialog: 'dialog',
      dt: 'term',
      em: 'emphasis',
      fieldset: 'group',
      figure: 'figure',
      hr: 'separator',
      html: 'generic',
      ins: 'insertion',
      main: 'main',
      math: 'math',
      menu: 'list',
      meter: 'meter',
      nav: 'navigation',
      ol: 'list',
      optgroup: 'group',
      option: 'option',
      output: 'status',
      p: 'paragraph',
      progress: 'progressbar',
      s: 'deletion',
      search: 'search',
      strong: 'strong',
      sub: 'subscript',
      summary: 'button',
      sup: 'superscript',
      table: 'table',
      tbody: 'rowgroup',
      textarea: 'textbox',
      tfoot: 'rowgroup',
      thead: 'rowgroup',
      time: 'time',
      tr: 'row',
      ul: 'list',
    };
    if (/^h[1-6]$/.test(name)) {
      return 'heading';
    }
    if (name === 'a' || name === 'area' || name === 'link') {
      return element.hasAttribute('href') ? 'link' : 'generic';
    }
    if (name === 'footer') {
      return isInsideLandmarkSection(element) ? 'generic' : 'contentinfo';
    }
    if (name === 'form') {
      return hasAccessibleName(element) ? 'form' : 'generic';
    }
    if (name === 'header') {
      return isInsideLandmarkSection(element) ? 'generic' : 'banner';
    }
    if (name === 'img') {
      return element.getAttribute('alt') === '' && !hasAccessibleName(element) && !hasGlobalAriaAttribute(element)
        ? 'presentation'
        : 'img';
    }
    if (name === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'image', 'reset', 'submit'].includes(type)) {
        return 'button';
      }
      if (type === 'checkbox' || type === 'radio') {
        return type;
      }
      if (type === 'range') {
        return 'slider';
      }
      if (['email', 'search', 'tel', 'text', 'url'].includes(type)) {
        if (element.hasAttribute('list')) {
          return 'combobox';
        }
        return type === 'search' ? 'searchbox' : 'textbox';
      }
      if (type === 'number') {
        return 'spinbutton';
      }
      return 'generic';
    }
    if (name === 'li') {
      return hasListParent(element) ? 'listitem' : 'generic';
    }
    if (name === 'section') {
      return hasAccessibleName(element) ? 'region' : 'generic';
    }
    if (name === 'select') {
      return element.multiple || element.size > 1 ? 'listbox' : 'combobox';
    }
    if (name === 'tbody' || name === 'tfoot' || name === 'thead' || name === 'tr') {
      const tableRole = exposedAncestorTableRole(element);
      if (tableRole !== 'table' && tableRole !== 'grid' && tableRole !== 'treegrid') {
        return 'generic';
      }
    }
    if (name === 'td' || name === 'th') {
      const tableRole = exposedAncestorTableRole(element);
      if (tableRole !== 'table' && tableRole !== 'grid' && tableRole !== 'treegrid') {
        return 'generic';
      }
      if (name === 'td') {
        return tableRole === 'table' ? 'cell' : 'gridcell';
      }
      const scope = (element.getAttribute('scope') || '').toLowerCase();
      if (scope === 'row' || scope === 'rowgroup') {
        return 'rowheader';
      }
      return 'columnheader';
    }
    return directRoles[name] || 'generic';
  };

  const explicitRoleAllowed = (element, role, implicitRole) => {
    const name = element.localName;
    if (name === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'password') {
        return false;
      }
      if (['button', 'image', 'reset', 'submit'].includes(type)) {
        return buttonRoles.has(role);
      }
      if (type === 'checkbox') {
        return ['checkbox', 'menuitemcheckbox', 'option', 'switch'].includes(role)
          || (role === 'button' && element.hasAttribute('aria-pressed'));
      }
      if (type === 'radio') {
        return role === 'radio' || role === 'menuitemradio';
      }
      if (type === 'text') {
        return ['combobox', 'searchbox', 'spinbutton', 'textbox'].includes(role);
      }
      return role === implicitRole;
    }
    if ((name === 'a' || name === 'area') && element.hasAttribute('href')) {
      return linkRoles.has(role);
    }
    if (name === 'button') {
      return buttonRoles.has(role);
    }
    if (/^h[1-6]$/.test(name)) {
      return ['heading', 'none', 'presentation', 'tab'].includes(role);
    }
    if (name === 'img') {
      return implicitRole === 'presentation'
        ? ['image', 'img', 'none', 'presentation'].includes(role)
        : imageRoles.has(role) || presentationalRoles.has(role);
    }
    if (name === 'li' && implicitRole === 'listitem') {
      return role === 'listitem';
    }
    if (name === 'nav') {
      return ['menu', 'menubar', 'navigation', 'none', 'presentation', 'tablist'].includes(role);
    }
    if (name === 'form') {
      return ['form', 'none', 'presentation', 'search'].includes(role);
    }
    if (name === 'select') {
      return role === implicitRole;
    }
    if (name === 'textarea') {
      return role === 'textbox';
    }
    if (name === 'td' || name === 'th') {
      const tableRole = exposedAncestorTableRole(element);
      if (tableRole === 'table') {
        return name === 'td'
          ? role === 'cell'
          : ['cell', 'columnheader', 'rowheader'].includes(role);
      }
      if (tableRole === 'grid' || tableRole === 'treegrid') {
        return name === 'td'
          ? role === 'gridcell'
          : ['columnheader', 'gridcell', 'rowheader'].includes(role);
      }
      return true;
    }
    if (name === 'ol' || name === 'ul' || name === 'menu') {
      return listRoles.has(role);
    }
    const constrainedRoles = {
      article: ['application', 'article', 'document', 'feed', 'main', 'none', 'presentation', 'region'],
      aside: ['complementary', 'feed', 'none', 'note', 'presentation', 'region', 'search'],
      footer: ['contentinfo', 'generic', 'group', 'none', 'presentation'],
      header: ['banner', 'generic', 'group', 'none', 'presentation'],
      hr: ['none', 'presentation', 'separator'],
      main: ['main', 'none', 'presentation'],
      progress: ['progressbar'],
    };
    return constrainedRoles[name]?.includes(role) ?? true;
  };

  const roleFor = (element) => {
    const implicitRole = implicitRoleFor(element);
    const explicitRole = element.getAttribute('role');
    if (explicitRole) {
      const validRole = explicitRole
        .toLowerCase()
        .split(/\s+/)
        .find((role) => validRoles.has(role) && explicitRoleAllowed(element, role, implicitRole));
      if (validRole) {
        if (
          presentationalRoles.has(validRole)
          && (isNativeFocusable(element) || hasGlobalAriaAttribute(element))
        ) {
          return implicitRole;
        }
        return validRole;
      }
    }
    return implicitRole;
  };

  function exposedAncestorTableRole(element) {
    const seen = new WeakSet();
    let ancestor = element.parentElement;
    for (let traversed = 0; ancestor && traversed < maxSelectorTraversalNodes; traversed += 1) {
      if (seen.has(ancestor)) {
        return undefined;
      }
      seen.add(ancestor);
      if (ancestor.localName === 'table') {
        const explicitRole = (ancestor.getAttribute('role') || '')
          .toLowerCase()
          .split(/\s+/)
          .find((role) => validRoles.has(role) && explicitRoleAllowed(ancestor, role, 'table'));
        if (presentationalRoles.has(explicitRole) && !isNativeFocusable(ancestor)) {
          return explicitRole;
        }
        return roleFor(ancestor);
      }
      ancestor = ancestor.parentElement;
    }
    return undefined;
  }

  const selectionString = (read, fallback, maxCharacters) => {
    try {
      const value = read();
      return truncate(typeof value === 'string' ? value : fallback, maxCharacters);
    } catch {
      return fallback;
    }
  };

  const selectionSelector = (element) => {
    const fallback = selectionString(() => element.localName, '*', maxSelectionSelectorChars);
    try {
      const selector = selectorFor(element);
      return selector.length <= maxSelectionSelectorChars ? selector : fallback;
    } catch {
      return fallback;
    }
  };

  const finiteGeometry = (bounds, property) => {
    try {
      const value = bounds?.[property];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  };

  const selectionPayload = (element) => {
    let bounds;
    try {
      bounds = element.getBoundingClientRect();
    } catch {
      bounds = undefined;
    }
    const elementName = selectionString(
      () => element.tagName.toLowerCase(),
      'unknown',
      maxSelectionComponentChars,
    );
    return {
      boundingBox: {
        height: finiteGeometry(bounds, 'height'),
        width: finiteGeometry(bounds, 'width'),
        x: finiteGeometry(bounds, 'x'),
        y: finiteGeometry(bounds, 'y'),
      },
      componentHint: selectionString(
        () => element.getAttribute('data-component') || elementName,
        elementName,
        maxSelectionComponentChars,
      ),
      computedRole: selectionString(() => roleFor(element), 'generic', 64),
      selector: selectionSelector(element),
      text: selectionString(
        () => (element.textContent || '').trim(),
        '',
        maxSelectionTextChars,
      ),
    };
  };

  window.addEventListener(
    'mousemove',
    (event) => {
      if (!selectionEnabled || !(event.target instanceof Element)) {
        return;
      }

      if (outlinedElement === event.target) {
        return;
      }

      if (outlinedElement) {
        outlinedElement.style.setProperty('outline', outlinedElementOutline.value, outlinedElementOutline.priority);
      }
      outlinedElement = event.target;
      outlinedElementOutline = {
        priority: outlinedElement.style.getPropertyPriority('outline'),
        value: outlinedElement.style.getPropertyValue('outline'),
      };
      outlinedElement.style.outline = '2px solid #7c3aed';
    },
    true,
  );

  window.addEventListener(
    'click',
    (event) => {
      if (!selectionEnabled || !(event.target instanceof Element)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      selectionEnabled = false;
      if (outlinedElement) {
        outlinedElement.style.setProperty('outline', outlinedElementOutline.value, outlinedElementOutline.priority);
        outlinedElement = undefined;
        outlinedElementOutline = undefined;
      }
      postToParent({ payload: selectionPayload(event.target), type: 'zapp:element-selected' });
    },
    true,
  );

  window.addEventListener('message', (event) => {
    if (!isTrustedParentMessage(event) || !event.data || typeof event.data !== 'object') {
      return;
    }

    if (event.data.type === 'zapp:selection-mode') {
      selectionEnabled = event.data.enabled === true;
      if (!selectionEnabled && outlinedElement) {
        outlinedElement.style.setProperty('outline', outlinedElementOutline.value, outlinedElementOutline.priority);
        outlinedElement = undefined;
        outlinedElementOutline = undefined;
      }
    }

    if (event.data.type === 'zapp:screenshot-request') {
      postToParent({ type: 'zapp:screenshot-requested' });
    }
  });
})();
