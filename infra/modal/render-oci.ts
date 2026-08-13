import process from 'node:process';
import { createForgeNodeBaseRecipe } from './images/forge-node-base.js';
import { renderOciDockerfile } from './images/oci.js';

const repositoryUrl = process.env['ZAPP_SOURCE_REPOSITORY'];
const commitSha = process.env['ZAPP_SOURCE_REVISION'];
if (!repositoryUrl || !commitSha) {
  throw new Error('ZAPP_SOURCE_REPOSITORY and ZAPP_SOURCE_REVISION are required');
}
process.stdout.write(renderOciDockerfile(createForgeNodeBaseRecipe({ repositoryUrl, commitSha })));
