{
  project = {
    name = "t3code";
    requirements = {
      apnsPrivateKey = {
        kind = "secret";
        description = "APNs signing key used for mobile push notifications";
        required = false;
        realizations = [ "release" ];
      };
    };
    parameters = {
      homeDirectory = {
        description = "Home and default provider working directory";
        required = false;
      };
      t3Home = {
        description = "Persistent T3 Code state directory";
        required = false;
      };
      codexHome = {
        description = "Codex provider state directory";
        required = false;
      };
      apnsKeyId = {
        description = "APNs key identifier";
        required = false;
      };
      apnsTeamId = {
        description = "Apple developer team identifier";
        required = false;
      };
      otlpMetricsUrl = {
        description = "OpenTelemetry metrics endpoint";
        required = false;
      };
      otlpTracesUrl = {
        description = "OpenTelemetry traces endpoint";
        required = false;
      };
      otlpServiceName = {
        description = "OpenTelemetry service identity";
        required = false;
      };
    };
    release = {
      package = "projectRelease";
      action = "web";
      preDeployTasks = {
        "wait-for-idle" = {
          action = "idle";
          failureMode = "defer";
          timeoutSec = 30;
        };
      };
      health = {
        paths = [ "/healthz" ];
        startupTimeoutSec = 300;
      };
      ingress = {
        compression = true;
        responseHeaders = {
          "Access-Control-Allow-Private-Network" = "true";
        };
        streamCloseDelaySec = 300;
      };
    };
  };
}
