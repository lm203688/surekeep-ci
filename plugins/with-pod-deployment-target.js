const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

const TARGET = '15.1';
const MARK = '# >>> forced pod deployment target >>>';

const SNIPPET = `
    ${MARK}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${TARGET}'
      end
    end
    # <<< forced pod deployment target <<<
`;

module.exports = function withPodDeploymentTarget(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) {
        return cfg;
      }
      let contents = fs.readFileSync(podfilePath, 'utf8');
      if (contents.includes(MARK)) {
        return cfg;
      }
      const anchor = /post_install do \|installer\|\n/;
      if (!anchor.test(contents)) {
        return cfg;
      }
      contents = contents.replace(anchor, (match) => match + SNIPPET);
      fs.writeFileSync(podfilePath, contents, 'utf8');
      return cfg;
    },
  ]);
};
