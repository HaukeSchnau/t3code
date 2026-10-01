import Foundation
import Security

/// A saved environment the phone can call: its base URL and the bearer token from pairing.
struct EnvironmentConnection {
  let environmentId: String
  let label: String
  let httpBaseUrl: URL
  let bearerToken: String
}

/// Reads the app's saved connections straight from the keychain, so notification replies and
/// watch requests work while React isn't running and the phone is locked.
///
/// The app writes the catalog through expo-secure-store (src/connection/catalog-store.ts and
/// src/persistence/mobile-secure-storage.ts). expo-secure-store stores each value as a generic
/// password whose service is the keychain service plus ":no-auth", with the key as its account.
enum EnvironmentConnections {
  private static let service = "t3code.background:no-auth"
  private static let catalogKey = "t3code.connection-catalog.v1"

  /// Every enabled environment with a bearer token, in catalog order.
  static func all() -> Result<[EnvironmentConnection], AgentReplyFailure> {
    readCatalog().map { catalog in
      let disabled = Set(catalog.disabledEnvironmentIds ?? [])
      return catalog.profiles.compactMap { profile in
        guard
          !disabled.contains(profile.environmentId),
          let httpBaseUrl = profile.httpBaseUrl.flatMap(URL.init(string:)),
          let bearerToken = catalog.credentials
            .first(where: { $0.connectionId == profile.connectionId })?
            .credential.token
        else { return nil }
        return EnvironmentConnection(
          environmentId: profile.environmentId,
          label: profile.label ?? profile.environmentId,
          httpBaseUrl: httpBaseUrl,
          bearerToken: bearerToken
        )
      }
    }
  }

  static func find(environmentId: String) -> Result<EnvironmentConnection, AgentReplyFailure> {
    switch readCatalog() {
    case .failure(let failure):
      return .failure(failure)
    case .success(let catalog):
      if catalog.disabledEnvironmentIds?.contains(environmentId) == true {
        return .failure(.switchedOff)
      }
    }
    return all().flatMap { connections in
      connections.first(where: { $0.environmentId == environmentId })
        .map { .success($0) } ?? .failure(.notSetUp)
    }
  }

  private static func readCatalog() -> Result<ConnectionCatalog, AgentReplyFailure> {
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
    return .success(catalog)
  }
}

/// The parts of packages/client-runtime's ConnectionCatalogDocument the phone needs. Only bearer
/// profiles have an httpBaseUrl, and bearer tokens are the only stored credential.
private struct ConnectionCatalog: Decodable {
  struct Profile: Decodable {
    let connectionId: String
    let environmentId: String
    let label: String?
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
