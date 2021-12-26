const { program, Option } = require('commander');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const octokit = require('@octokit/request');

program.version('0.0.1')
program
    .argument('<repo>', 'Github repository')
    .argument('<deployment_id>', 'Deployment ID')
    .argument('<deploy_dir>', 'Deployment directory')
program
    .option('-e, --environment <environment>', 'Deployment environment', 'production')
    .addOption(new Option('-t, --token <token>', 'Github token').env('GITHUB_TOKEN'));

program.parse();

const options = program.opts();
const { token, environment } = options;

const [ owner_repo, deployment_id, deploy_dir ] = program.args;
const [ owner, repo ] = owner_repo.split('/');

const server = require('os').hostname();

const requestWithAuth = octokit.request.defaults({
    headers: {authorization: `token ${token}`},
    owner,
    repo,
});

(async () => {
    try {
        console.log(`Getting deployment data (id: ${deployment_id})`)
        const {data: deployment} = await requestWithAuth('GET /repos/{owner}/{repo}/deployments/{deployment_id}', {deployment_id});

        console.log('Setting deployment status to in_progress');
        await requestWithAuth('POST /repos/{owner}/{repo}/deployments/{deployment_id}/statuses', {
            deployment_id,
            state: 'in_progress',
            description: `Started ${environment} deployment on ${server}`,
            environment
        });

        console.log('Getting run artifacts');
        const run_id = deployment.payload;
        const artifacts = await (async () => {
            for (let x = 0; x < 5; x++) {
                let {data} = await requestWithAuth('GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts', {run_id});
                if (data.total_count) return data.artifacts;
                console.log('Retrying...');
                await new Promise(res => setTimeout(res, 1500));
            }
            throw new Error('No artifacts found');
        })()
        const artifact = artifacts.find(x => x.name === 'dist');
        if (!artifact) throw new Error('No artifact named dist');

        console.log('Getting artifact download URL');
        const res = await requestWithAuth('HEAD /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}', {
            artifact_id: artifact.id,
            archive_format: 'zip',
            request: {
                redirect: "manual",
            },
        });
        const download_url = res.headers.location;

        console.log(`Downloading artifact from ${download_url}`);
        await exec(`wget "${download_url}" -O build.zip`, {cwd: deploy_dir});

        console.log('Cleaning deployment directory');
        await exec(`rm -rf ui api || true`, {cwd: deploy_dir});

        console.log('Extracting build');
        await exec(`unzip build.zip`, {cwd: deploy_dir});

        console.log('Setting deployment status to success');
        await requestWithAuth('POST /repos/{owner}/{repo}/deployments/{deployment_id}/statuses', {
            deployment_id,
            state: 'success',
            environment
        });

    } catch (error) {

        console.log(error);
        console.log('Setting deployment status to failure');
        await requestWithAuth('POST /repos/{owner}/{repo}/deployments/{deployment_id}/statuses', {
            deployment_id,
            state: 'failure',
            description: error.toString(),
            environment
        });

        process.exit(1);
    }

})()