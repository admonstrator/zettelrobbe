const fs = require('fs');
const path = require('path');
const swaggerJSDoc = require('swagger-jsdoc');

const bundledOpenApiPath = path.join(__dirname, 'OPENAPI', 'openapi.json');

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Zettelrobbe API Documentation',
    version: '1.0.0',
    description: 'API documentation for the Zettelrobbe application',
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT',
    },
    contact: {
      name: 'admonstrator',
      url: 'https://github.com/admonstrator',
    },
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Development server',
    },
    // Add production server details if applicable
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT authentication token obtained from the /login endpoint. The token should be included in the Authorization header as "Bearer {token}".'
      },
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'API key for programmatic access. This key can be generated or regenerated using the /api/key-regenerate endpoint. Include the key in the x-api-key header for authentication.'
      },
    },
  },
  security: [
    { BearerAuth: [] },
    { ApiKeyAuth: [] }
  ]
};

const options = {
  swaggerDefinition,
  apis: ['./server.js', './routes/*.js', './schemas.js'], // Path to the API docs
};

function loadBundledOpenApiSpec() {
  try {
    const fileContent = fs.readFileSync(bundledOpenApiPath, 'utf8');
    return JSON.parse(fileContent);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Could not load bundled OpenAPI spec from ${bundledOpenApiPath}: ${error.message}`);
    }
    return null;
  }
}

function generateOpenApiSpec() {
  return swaggerJSDoc(options);
}

const swaggerSpec = loadBundledOpenApiSpec() || generateOpenApiSpec();

module.exports = swaggerSpec;