const assert = require('assert');
const dnsPromises = require('dns').promises;

const { validateApiUrl } = require('../services/serviceUtils');

const originalResolve4 = dnsPromises.resolve4;
const originalResolve6 = dnsPromises.resolve6;

function createDnsError(code = 'ENOTFOUND') {
  const error = new Error('DNS lookup failed');
  error.code = code;
  return error;
}

async function withMockedDns(mockMap, fn) {
  dnsPromises.resolve4 = async (hostname) => {
    const entry = mockMap[hostname] || {};
    if (entry.resolve4Error) {
      throw entry.resolve4Error;
    }
    if (entry.resolve4) {
      return entry.resolve4;
    }
    throw createDnsError();
  };

  dnsPromises.resolve6 = async (hostname) => {
    const entry = mockMap[hostname] || {};
    if (entry.resolve6Error) {
      throw entry.resolve6Error;
    }
    if (entry.resolve6) {
      return entry.resolve6;
    }
    throw createDnsError('ENODATA');
  };

  try {
    await fn();
  } finally {
    dnsPromises.resolve4 = originalResolve4;
    dnsPromises.resolve6 = originalResolve6;
  }
}

async function main() {
  await withMockedDns(
    {
      'loopback.test': { resolve4: ['127.0.0.1'] },
      'private-ipv4.test': { resolve4: ['192.168.1.23'] },
      'linklocal-ipv6.test': { resolve6: ['fe80::1'] },
      'ula-ipv6.test': { resolve6: ['fc00::1234'] },
      'mixed-answer.test': { resolve4: ['93.184.216.34', '192.168.1.10'] },
      'public-domain.test': {
        resolve4: ['93.184.216.34'],
        resolve6: ['2606:2800:220:1:248:1893:25c8:1946'],
      },
    },
    async () => {
      const loopbackDomain = await validateApiUrl(
        'http://loopback.test/resource',
        { allowPrivateIPs: false }
      );
      assert.strictEqual(
        loopbackDomain.valid,
        false,
        'Domain resolving to 127.0.0.1 must be blocked'
      );

      const privateIpv4Domain = await validateApiUrl(
        'http://private-ipv4.test/resource',
        { allowPrivateIPs: false }
      );
      assert.strictEqual(
        privateIpv4Domain.valid,
        false,
        'Domain resolving to 192.168.x.x must be blocked'
      );

      const linkLocalIpv6Domain = await validateApiUrl(
        'http://linklocal-ipv6.test/resource',
        { allowPrivateIPs: false }
      );
      assert.strictEqual(
        linkLocalIpv6Domain.valid,
        false,
        'Domain resolving to fe80::/10 must be blocked'
      );

      const ulaIpv6Domain = await validateApiUrl(
        'http://ula-ipv6.test/resource',
        { allowPrivateIPs: false }
      );
      assert.strictEqual(
        ulaIpv6Domain.valid,
        false,
        'Domain resolving to fc00::/7 must be blocked'
      );

      const mixedResolution = await validateApiUrl(
        'http://mixed-answer.test/resource',
        { allowPrivateIPs: false }
      );
      assert.strictEqual(
        mixedResolution.valid,
        false,
        'A single private DNS answer must block the URL'
      );

      const publicDomain = await validateApiUrl(
        'http://public-domain.test/resource',
        { allowPrivateIPs: false }
      );
      assert.strictEqual(
        publicDomain.valid,
        true,
        'Public domain must remain allowed'
      );

      const privateAllowed = await validateApiUrl(
        'http://private-ipv4.test/resource',
        { allowPrivateIPs: true }
      );
      assert.strictEqual(
        privateAllowed.valid,
        true,
        'Private targets should be allowed when allowPrivateIPs=true'
      );

      const localhostStillBlocked = await validateApiUrl(
        'http://loopback.test/resource',
        {
          allowPrivateIPs: true,
          allowLocalhost: false,
        }
      );
      assert.strictEqual(
        localhostStillBlocked.valid,
        false,
        'Loopback should remain blocked unless allowLocalhost=true'
      );
    }
  );

  // Resolvers hand out IPv4-mapped addresses in compressed hex form
  // (::ffff:7f00:1), which the IPv6 rules do not classify. An attacker who
  // controls a zone can publish such an AAAA record and reach loopback, a
  // private network or the cloud metadata service.
  await withMockedDns(
    {
      'mapped-loopback.test': { resolve6: ['::ffff:7f00:1'] },
      'mapped-metadata.test': { resolve6: ['::ffff:a9fe:a9fe'] },
      'mapped-private.test': { resolve6: ['::ffff:c0a8:1'] },
      'mapped-dotted.test': { resolve6: ['::ffff:127.0.0.1'] },
      'nat64-loopback.test': { resolve6: ['64:ff9b::7f00:1'] },
      'compat-loopback.test': { resolve6: ['::7f00:1'] },
      'public-ipv6.test': { resolve6: ['2606:2800:220:1:248:1893:25c8:1946'] },
    },
    async () => {
      const mappedLoopback = await validateApiUrl(
        'http://mapped-loopback.test/resource',
        { allowPrivateIPs: false }
      );
      assert.strictEqual(
        mappedLoopback.valid,
        false,
        'AAAA record ::ffff:7f00:1 must be blocked as loopback'
      );

      const mappedMetadata = await validateApiUrl(
        'http://mapped-metadata.test/resource',
        { allowPrivateIPs: false }
      );
      assert.strictEqual(
        mappedMetadata.valid,
        false,
        'AAAA record ::ffff:a9fe:a9fe must be blocked as metadata'
      );

      const mappedPrivate = await validateApiUrl(
        'http://mapped-private.test/resource',
        { allowPrivateIPs: false }
      );
      assert.strictEqual(
        mappedPrivate.valid,
        false,
        'AAAA record ::ffff:c0a8:1 must be blocked as private'
      );

      const mappedDotted = await validateApiUrl(
        'http://mapped-dotted.test/resource',
        { allowPrivateIPs: false }
      );
      assert.strictEqual(
        mappedDotted.valid,
        false,
        'Dotted IPv4-mapped spelling must stay blocked'
      );

      const nat64Loopback = await validateApiUrl(
        'http://nat64-loopback.test/resource',
        { allowPrivateIPs: false }
      );
      assert.strictEqual(
        nat64Loopback.valid,
        false,
        'NAT64-embedded loopback must be blocked'
      );

      const compatLoopback = await validateApiUrl(
        'http://compat-loopback.test/resource',
        { allowPrivateIPs: false }
      );
      assert.strictEqual(
        compatLoopback.valid,
        false,
        'IPv4-compatible loopback must be blocked'
      );

      const mappedLoopbackPrivateAllowed = await validateApiUrl(
        'http://mapped-loopback.test/resource',
        {
          allowPrivateIPs: true,
          allowLocalhost: false,
        }
      );
      assert.strictEqual(
        mappedLoopbackPrivateAllowed.valid,
        false,
        'Mapped loopback must stay blocked when only private networks are allowed'
      );

      const publicIpv6 = await validateApiUrl(
        'http://public-ipv6.test/resource',
        { allowPrivateIPs: false }
      );
      assert.strictEqual(
        publicIpv6.valid,
        true,
        'Public AAAA record must remain allowed'
      );
    }
  );

  // URL.hostname keeps the brackets around an IPv6 literal, so the literal has
  // to be unwrapped before it can be classified instead of being sent to the
  // resolver.
  await withMockedDns({}, async () => {
    const loopbackLiteral = await validateApiUrl('http://[::1]/resource', {
      allowPrivateIPs: false,
    });
    assert.strictEqual(
      loopbackLiteral.valid,
      false,
      'IPv6 loopback literal must be blocked'
    );
    assert.match(
      loopbackLiteral.error,
      /Localhost/,
      'IPv6 loopback literal must be reported as localhost'
    );

    const mappedLiteral = await validateApiUrl(
      'http://[::ffff:7f00:1]/resource',
      { allowPrivateIPs: false }
    );
    assert.strictEqual(
      mappedLiteral.valid,
      false,
      'IPv4-mapped literal must be blocked'
    );
    assert.match(
      mappedLiteral.error,
      /Localhost/,
      'IPv4-mapped literal must be reported as localhost'
    );

    const metadataLiteral = await validateApiUrl(
      'http://[::ffff:169.254.169.254]/resource',
      { allowPrivateIPs: false }
    );
    assert.strictEqual(
      metadataLiteral.valid,
      false,
      'IPv4-mapped metadata literal must be blocked'
    );

    const ulaLiteral = await validateApiUrl('http://[fd00::1]/resource', {
      allowPrivateIPs: false,
    });
    assert.strictEqual(
      ulaLiteral.valid,
      false,
      'IPv6 ULA literal must be blocked'
    );

    const publicLiteral = await validateApiUrl(
      'http://[2606:2800:220:1:248:1893:25c8:1946]/resource',
      {
        allowPrivateIPs: false,
      }
    );
    assert.strictEqual(
      publicLiteral.valid,
      true,
      'Public IPv6 literal must be allowed'
    );
  });
}

main()
  .then(() => {
    console.log('[PASS] SSRF validator DNS resolution regressions are covered');
  })
  .catch((error) => {
    console.error('[FAIL] SSRF validator test failed:', error.message);
    process.exitCode = 1;
  });
