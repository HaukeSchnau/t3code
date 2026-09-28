import Foundation
import Security

struct AgentReplyConnection {
  let httpBaseUrl: URL
  let bearerToken: String
}

/// Reads the app's saved connections straight from the keychain, so a Reply works while React
/// isn't running and the phone is locked.
///
/// The app writes the catalog through expo-secure-store (src/connection/catalog-store.ts and
/// src/persistence/mobile-secure-storage.ts). expo-secure-store stores each value as a generic
/// password whose service is the keychain service plus ":no-auth", with the key as its account.
enum AgentReplyConnections {
  private static let service = "t3code.background:no-auth"
  private static let catalogKey = "t3code.connection-catalog.v1"

  static func find(environmentId: String) -> Result<AgentReplyConnection, AgentReplyFailure> {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: Data(catalogKey.utf8),
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
      break
    case errSecItemNotFound:
      // The app moves its storage to this service on the first launch after updating.
      return .failure(.notSetUp)
    default:
      // Most likely errSecInteractionNotAllowed: no unlock since the phone restarted.
      return .failure(.locked)
    }
    guard
      let data = item as? Data,
      let catalog = try? JSONDecoder().decode(ConnectionCatalog.self, from: data)
    else { return .failure(.notSetUp) }
    if catalog.disabledEnvironmentIds?.contains(environmentId) == true {
      return .failure(.switchedOff)
    }
    for profile in catalog.profiles where profile.environmentId == environmentId {
      guard
        let httpBaseUrl = profile.httpBaseUrl.flatMap(URL.init(string:)),
        let bearerToken = catalog.credentials
          .first(where: { $0.connectionId == profile.connectionId })?
          .credential.token
      else { continue }
      return .success(AgentReplyConnection(httpBaseUrl: httpBaseUrl, bearerToken: bearerToken))
    }
    return .failure(.notSetUp)
  }
}

/// The parts of packages/client-runtime's ConnectionCatalogDocument a reply needs. Only bearer
/// profiles have an httpBaseUrl, and bearer tokens are the only stored credential.
private struct ConnectionCatalog: Decodable {
  struct Profile: Decodable {
    let connectionId: String
    let environmentId: String
    let httpBaseUrl: String?
  }

  struct StoredCredential: Decodable {
    struct Credential: Decodable {
      let token: String?
    }

    let connectionId: String
    let credential: Credential
  }

  let profiles: [Profile]
  let credentials: [StoredCredential]
  let disabledEnvironmentIds: [String]?
}
