const { safeExtractRelativePath } = require('./serviceUtils');

class CachedNameIdEnum {
  constructor(
    element_type_name,
    url_prefix,
    similarity_prompt,
    cache_ttl_access,
    ai_service,
    page_size = 100
  ) {
    this.ai_service = ai_service;
    this.element_type_name = element_type_name;
    this.url_prefix = url_prefix;
    this.similarity_prompt = similarity_prompt;
    this.cache_ttl_access = cache_ttl_access;
    // Asked for on every page request. DRF clamps to its own max_page_size
    // rather than rejecting, so a server that allows less simply pages more.
    this.page_size = page_size;
    this.cache_last_fetch_time = 0;
    this.cache_refresh_promise = null;
    this.elements_by_id = new Map();
    this.elements_by_name = new Map();
    this.element_list = [];
  }

  _clear() {
    this.elements_by_id.clear();
    this.elements_by_name.clear();
    this.element_list = [];
  }

  _add_all(elements) {
    this.element_list = this.element_list.concat(elements);
    this.element_list.forEach((element) => {
      this.elements_by_id.set(element.id, element);
      this.elements_by_name.set(element.name.toLowerCase(), element);
    });
  }

  async _cache_refill(client) {
    this._clear();
    this._add_all(await this._fetchAll(client));
  }

  _result_element_from_element(element) {
    return {
      id: element.id,
      name: element.name,
    };
  }

  async _fetchAll(client) {
    this._checkClient(client);
    let nextUrl = this.url_prefix;
    let existing_elements = [];
    while (nextUrl) {
      // page_size must ride in `params` — a bare property on the axios config
      // is silently dropped so that the server answers with its default page size.
      const response = await client.get(nextUrl, {
        params: { page_size: this.page_size },
      });
      existing_elements = existing_elements.concat(response.data.results);
      // Safely extract relative path from next URL to prevent SSRF
      if (response.data.next) {
        nextUrl = safeExtractRelativePath(response.data.next, client);
        if (nextUrl) {
          console.debug(
            `[DEBUG] Next page URL: ${nextUrl} elements fetched so far: ${existing_elements.length}`
          );
        } else {
          console.warn(`[WARN] Response has data.next but Next page URL is 
            empty. elements fetched so far: ${existing_elements.length}`);
        }
      } else {
        nextUrl = null;
        this.cache_last_fetch_time = Date.now();
        console.debug(
          `[DEBUG] Fetched ${existing_elements.length} ${this.element_type_name}s`
        );
        console.debug(
          `[DEBUG] Cache contains these ${this.element_type_name}s now: 
          ${existing_elements.map((element) => element.name).join(', ')}`
        );
      }
    }
    return existing_elements;
  }

  async _check_cache_is_not_outdated(
    client,
    cache_ttl = this.cache_ttl_access()
  ) {
    if (this.element_list.length === 0) {
      await this.flush_cache(client);
      return;
    }
    if (cache_ttl === 0) return; // No timeout configured, refresh only on cache miss
    if (cache_ttl > 0) {
      // check for timeout and refresh if necessary
      const cacheAge = Date.now() - this.cache_last_fetch_time;
      if (cacheAge < cache_ttl) return;
      const ageSeconds = Math.floor(cacheAge / 1000);
      const ttlSeconds = Math.floor(cache_ttl / 1000);
      const expireTime = new Date(
        this.cache_last_fetch_time + cache_ttl
      ).toISOString();
      console.debug(
        `[DEBUG] ${this.element_type_name} cache expired (age: ${ageSeconds}s, TTL: ${ttlSeconds}s, expired at: ${expireTime})`
      );
    }
    // cache_ttl < 0 or expired
    await this.flush_cache(client);
  }

  async _getByName(name, client, cache_ttl = this.cache_ttl_access()) {
    await this._check_cache_is_not_outdated(client, cache_ttl);
    let match = this.elements_by_name.get(name.toLowerCase());
    if (match) {
      console.debug(
        `[DEBUG] Found exact match for ${this.element_type_name} "${match.name}" with ID ${match.id}`
      );
      return this._result_element_from_element(match);
    }
    match = await this._findSimilar(name);
    if (match) {
      console.debug(
        `[DEBUG] Found similar match for ${this.element_type_name} "${name}": "${match.name}" with ID ${match.id}`
      );
      return this._result_element_from_element(match);
    }
    console.debug(
      `[DEBUG] No exact nor similar match found for ${this.element_type_name} "${name}"`
    );
    return null;
  }

  async _getById(id, client, cache_ttl = this.cache_ttl_access()) {
    if (id === 0) {
      console.error(`[ERROR] Id cannot be 0` + new Error().stack);
      return null;
    }
    await this._check_cache_is_not_outdated(client, cache_ttl);
    let match = this.elements_by_id.get(id);
    if (match) {
      console.log(
        `[DEBUG] Found ${this.element_type_name} by ID #${match.id}: "${match.name}"`
      );
      return this._result_element_from_element(match);
    }
    console.log(`[DEBUG] No ${this.element_type_name} with ID #${id} found`);
    return null;
  }

  async _findSemanticMatch(name) {
    let selectPrompt =
      `These ${this.element_type_name}s are known: ` +
      `${this.element_list.map((e) => `${e.name} (ID: ${e.id})`).join(', ')}. ` +
      `Is ${name} contained in this list? ${this.similarity_prompt}`;

    const format = {
      type: 'object',
      properties: {
        match: {
          type: ['object', 'null'],
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
          },
          required: ['id', 'name'],
        },
      },
      required: ['match'],
    };
    try {
      let aiResult = await this.ai_service.generateAnswer(
        selectPrompt,
        undefined,
        300,
        format
      );
      console.debug(`[DEBUG] AI result: ${aiResult}`);
      let parsedResult =
        typeof aiResult === 'string' ? JSON.parse(aiResult) : aiResult;
      if (!parsedResult.match) {
        console.debug(
          `[DEBUG] No ${this.element_type_name} found similar to "${name}"`
        );
        return null;
      }
      const matchedElement = parsedResult.match;
      console.debug(
        `[DEBUG] Found similar match for ${this.element_type_name} "${name}": "${matchedElement.name}" with ID ${matchedElement.id}`
      );
      return this._result_element_from_element(matchedElement);
    } catch (error) {
      console.error(
        '[ERROR] while searching for existing correspondent:',
        error.message
      );
    }

    return null;
  }

  async _findMatchByFilter(name, filter, filterName) {
    let elementResultList = await this.element_list.filter(filter);
    if (elementResultList.length === 0) {
      console.log(
        `[DEBUG] No ${this.element_type_name} found with ${filterName} "${name}"`
      );
      return null;
    }
    if (elementResultList.length > 1) {
      console.log(
        `[DEBUG] Multiple ${this.element_type_name} found with a ${filterName} "${name}"`,
        `[DEBUG] "${elementResultList.map((element) => element.name).join('", "')}"`
      );
      return null;
    }
    const matchedElement = elementResultList[0];
    console.log(
      `[DEBUG] Found "${filterName}" match for ${this.element_type_name} "${name}": "${matchedElement.name}" with ID ${matchedElement.id}`
    );
    return this._result_element_from_element(matchedElement);
  }

  async _findSubString(name) {
    return this._findMatchByFilter(
      name,
      (element) => element.name.toLowerCase().includes(name.toLowerCase()),
      'substring in'
    );
  }

  _splitToTerms(name) {
    let terms = name
      .toLowerCase()
      .replace(/[\s-_.:]+/g, ' ')
      .split(' ');
    terms = terms.filter((term) => term.length > 0);
    console.debug(`[debug] ${name} in terms: ${terms.join(', ')}`);
    return terms;
  }

  _isMatchBySubterms(name, candidate) {
    let nameTerms = this._splitToTerms(name);
    let candidateTerms = this._splitToTerms(candidate);
    const termsToMatch = candidateTerms.length;
    let matchNo = 0;
    for (let candidateTerm of candidateTerms) {
      if (nameTerms.includes(candidateTerm)) {
        matchNo++;
      }
    }
    let result = termsToMatch > 0 && matchNo === termsToMatch;
    console.debug(
      `[debug] ${name} is ${result ? '' : 'not'} in: ${candidateTerms.join(', ')}`
    );
    return result;
  }

  async _findByTermMatch(name) {
    return this._findMatchByFilter(
      name,
      (element) => this._isMatchBySubterms(name, element.name),
      'has all terms'
    );
  }

  async _findSimilar(name) {
    // Todo: implement methods to find similar element by matching with single word permutations and with something
    //  like hemming distance before asking ai to spare tokens
    let match = await this._findSubString(name);
    if (match) {
      return match;
    }
    match = await this._findByTermMatch(name);
    if (match) {
      return match;
    }
    return this._findSemanticMatch(name);
  }

  _checkClient(client) {
    if (!client) {
      throw new Error('No client provided.');
    }
  }

  _checkDefined(name, value) {
    if (value === undefined || value === null) {
      throw new Error(`Mandatory argument ${name} is undefined or null.`);
    }
  }

  /**************************************************************************
   *
   * Public API
   *
   *************************************************************************/

  flush_cache(client) {
    this._checkClient(client);
    if (this.cache_refresh_promise) {
      return this.cache_refresh_promise;
    }
    // No race condition: synchronous code is never preempted in Node.js's
    // event loop, so no other call can reach here between the check above
    // and the assignment below.
    this.cache_refresh_promise = this._cache_refill(client).finally(() => {
      this.cache_refresh_promise = null;
    });
    return this.cache_refresh_promise;
  }

  async getByName(client, name) {
    this._checkClient(client);
    this._checkDefined('name', name);
    let match = await this._getByName(name, client);
    if (!match) {
      console.log(
        `[DEBUG] Cache miss for ${this.element_type_name} "${name}", refreshing cache`
      );
      match = await this._getByName(name, client, -1);
    }
    return match;
  }

  async getById(client, id) {
    this._checkClient(client);
    this._checkDefined('id', id);
    if (id === 0) {
      return this._getById(id, client);
    }
    let match = await this._getById(id, client);
    if (!match && id > Math.max(...this.elements_by_id.keys())) {
      console.log(
        `[DEBUG] Cache miss for ${this.element_type_name} #${id}, refreshing cache`
      );
      match = await this._getById(id, client, -1);
    }
    return match;
  }

  /**
   * Insert a single element (e.g., one just created on the server) into the
   * cache without a full refresh.
   */
  add(element) {
    if (!element || element.id == null || !element.name) {
      return;
    }
    this.elements_by_id.set(element.id, element);
    this.elements_by_name.set(element.name.toLowerCase(), element);
    if (!this.element_list.some((e) => e.id === element.id)) {
      this.element_list.push(element);
    }
  }

  /**
   * Drop the cached elements without reading the server; the next access
   * refills the cache.
   */
  invalidate() {
    this._clear();
  }

  async visitAllContainedElements(client, visitor) {
    this._checkClient(client);
    await this._check_cache_is_not_outdated(client);
    let result_set = new Set();
    for (let element of this.element_list.values()) {
      visitor(element, result_set);
    }
    return result_set;
  }

  async getCount(client) {
    this._checkClient(client);
    await this._check_cache_is_not_outdated(client);
    return this.element_list.length;
  }

  /**
   * All cached elements as `{id, name}` objects, refreshing when stale.
   */
  async getAll(client) {
    this._checkClient(client);
    await this._check_cache_is_not_outdated(client);
    return this.element_list.map((element) =>
      this._result_element_from_element(element)
    );
  }
}

module.exports = {
  CachedNameIdEnum,
};
