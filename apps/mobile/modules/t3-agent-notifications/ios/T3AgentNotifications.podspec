Pod::Spec.new do |s|
  s.name           = 'T3AgentNotifications'
  s.version        = '1.0.0'
  s.summary        = 'Reply actions for T3 Code agent notifications.'
  s.description    = 'Sends notification replies to the paired environment without starting React.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '16.4',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoNotifications'
  s.frameworks = 'WatchConnectivity'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.swift"
end
