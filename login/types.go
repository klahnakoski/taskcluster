// This source code file is AUTO-GENERATED by github.com/taskcluster/jsonschema2go

package login

type (
	// A response containing temporary credentials.
	//
	// See http://schemas.taskcluster.net/login/v1/credentials-response.json#
	CredentialsResponse struct {

		// Syntax:     ^[a-zA-Z0-9_-]{22,66}$
		//
		// See http://schemas.taskcluster.net/login/v1/credentials-response.json#/properties/accessToken
		AccessToken string `json:"accessToken"`

		// See http://schemas.taskcluster.net/login/v1/credentials-response.json#/properties/certificate
		Certificate string `json:"certificate"`

		// Syntax:     ^[A-Za-z0-9@/:._-]+$
		//
		// See http://schemas.taskcluster.net/login/v1/credentials-response.json#/properties/clientId
		ClientID string `json:"clientId"`
	}
)
