export function areExperimentalFeaturesEnabled(environment = process.env) {
  return environment.PI_EXPERIMENTAL === "1";
}
